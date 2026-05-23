// ==UserScript==
// @name 智谱GLM Coding抢购助手 V6.0
// @namespace http://tampermonkey.net/
// @version 4.0
// @description 验证码对抗版：单次请求放行+自动重触发购买按钮循环
// @author 帅D
// @match *:**bigmodel*/**
// @match *://www.bigmodel.cn/**
// @match https://www.bigmodel.cn/glm-coding
// @match https://open.bigmodel.cn/glm-coding
// @match https://bigmodel.cn/glm-coding*
// @run-at document-start
// @grant none
// @license MIT
// ==/UserScript==

(function () {
    'use strict';

    // ======================== 配置 ========================
    const CFG = {
        delay: 100,
        maxRetry: 300,
        ignoreSoldOut: false,   // 售罄后是否继续重试（测试用）
        PREVIEW: '/api/biz/pay/preview',
        CHECK: '/api/biz/pay/check',
    };

    // ======================== 全局状态 ========================
    const S = {
        status: 'idle',       // idle | retrying | waiting_user | success | failed | scheduled
        count: 0,
        bizId: null,
        captured: null,
        cache: null,
        lastSuccess: null,
        proactive: false,
        timerId: null,
        logs: [],
        buyButton: null,
        productName: '',
        buyButtonSelector: '',
        buyButtonText: '',
        targetProductId: '',
        // 时间同步
        timeOffset: 0,           // 本地与服务器时间偏移量(ms), 正值=本地慢
        syncCount: 0,            // 同步次数
        syncIntervalId: null,    // 同步循环定时器
        targetTime: null,        // 定时目标时间戳(ms)
        scheduledProductId: null,// 定时目标套餐
        heartbeatId: null,       // 心跳定时器
        countdownId: null,       // 倒计时更新定时器
        lastSyncOk: false,       // 上次同步是否成功
    };

    // 页面扫描到的套餐列表 [{productId, productName, type, salePrice, unit, soldOut, btn}]
    let pageProducts = [];

    let stopRequested = false;
    let recovering = false;
    let recoveryAttempts = 0;
    let firstClickHandled = false;

    // ======================== 工具函数 ========================
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const ts = () => {
        const d = new Date();
        const hms = d.toLocaleTimeString('zh-CN', { hour12: false });
        return `${hms}.${String(d.getMilliseconds()).padStart(3, '0')}`;
    };

    function log(msg) {
        S.logs.push(`${ts()} ${msg}`);
        if (S.logs.length > 120) S.logs.shift();
        console.log(`[GLM抢购] ${ts()} ${msg}`);
        refreshLog();
    }

    function extractHeaders(h) {
        const o = {};
        if (!h) return o;
        if (h instanceof Headers) h.forEach((v, k) => (o[k] = v));
        else if (Array.isArray(h)) h.forEach(([k, v]) => (o[k] = v));
        else Object.entries(h).forEach(([k, v]) => (o[k] = v));
        return o;
    }

    function extractProductId(body) {
        if (!body) return;
        try {
            const obj = typeof body === 'string' ? _parse(body) : body;
            if (obj && obj.productId) {
                S.targetProductId = obj.productId;
                log(`📌 锁定 productId=${obj.productId}`);
            }
        } catch (e) {}
    }

    // ======================== 页面套餐扫描 ========================
    function scanVueProducts() {
        pageProducts = [];
        const btns = document.querySelectorAll('.buy-btn');
        for (const btn of btns) {
            const vm = btn.__vue__;
            if (!vm) continue;
            let cur = vm.$parent;
            for (let i = 0; i < 5 && cur; i++) {
                const cd = cur.$props && cur.$props.cardData;
                if (cd && cd.productId) {
                    pageProducts.push({
                        productId: cd.productId,
                        productName: cd.productName || cd.title || cd.name || cd.type || '?',
                        type: cd.type || '',
                        salePrice: cd.salePrice,
                        unit: cd.unit || '',
                        soldOut: cd.soldOut,
                        btn: btn,
                    });
                    break;
                }
                cur = cur.$parent;
            }
        }
        return pageProducts;
    }

    // 从按钮的 Vue 组件实例中提取 cardData.productId
    function getProductIdFromVue(btn) {
        try {
            const vm = btn.__vue__;
            if (!vm) return null;
            let cur = vm.$parent;
            for (let i = 0; i < 5 && cur; i++) {
                const cd = cur.$props && cur.$props.cardData;
                if (cd && cd.productId) return cd.productId;
                cur = cur.$parent;
            }
        } catch (e) {}
        return null;
    }

    function findButtonByProductId(pid) {
        if (!pid) return null;
        const buyBtns = document.querySelectorAll('.buy-btn');
        for (const btn of buyBtns) {
            if (getProductIdFromVue(btn) === pid) return btn;
        }
        return null;
    }

    // ======================== JSON.parse 深层篡改 (UI 补丁) ========================
    const _parse = JSON.parse;
    JSON.parse = function (text, reviver) {
        let result = _parse(text, reviver);
        try {
            (function fix(obj) {
                if (!obj || typeof obj !== 'object') return;
                if (obj.isSoldOut === true) obj.isSoldOut = false;
                if (obj.soldOut === true) obj.soldOut = false;
                if (obj.disabled === true && (obj.price !== undefined || obj.productId || obj.title)) obj.disabled = false;
                if (obj.stock === 0) obj.stock = 999;
                for (let k in obj) if (obj[k] && typeof obj[k] === 'object') fix(obj[k]);
            })(result);
        } catch (e) {}
        return result;
    };

    // ======================== 核心处理 ========================
    const _fetch = window.fetch;

    // ======================== 限流防护 ========================
    const RATE_LIMIT_URL = '/api/biz/rate-limit/check';
    const RATE_LIMIT_PAGE = '/html/rate-limit.html';

    // 限流接口伪造响应
    const RATE_LIMIT_FAKE = JSON.stringify({ code: 200, msg: '操作成功', data: true, success: true });

    // 第二层: 检测限流页面自动跳回
    if (location.pathname === '/html/rate-limit.html') {
        const params = new URLSearchParams(location.search);
        const redirect = params.get('redirect') || '/glm-coding';
        const bounceCount = parseInt(sessionStorage.getItem('glm_bounce') || '0', 10);
        if (bounceCount < 3 && redirect.startsWith('/') && !redirect.startsWith('//')) {
            sessionStorage.setItem('glm_bounce', String(bounceCount + 1));
            location.replace(redirect);
        }
    } else {
        // 正常页面，清除跳转计数器
        sessionStorage.removeItem('glm_bounce');
    }

    // ======================== 以下为原有 Fetch/XHR 拦截器（含限流拦截） ========================

    async function handlePreviewResponse(text) {
        let data;
        try { data = _parse(text); } catch { data = null; }

        // ---- 成功：拿到 bizId ----
        if (data && data.code === 200 && data.data && data.data.bizId) {
            const bizId = data.data.bizId;
            log(`🔑 获取到 bizId=${bizId}，校验中…`);

            try {
                const checkUrl = `${location.origin}${CFG.CHECK}?bizId=${bizId}`;
                const checkResp = await _fetch(checkUrl, { credentials: 'include' });
                const checkText = await checkResp.text();
                let checkData;
                try { checkData = _parse(checkText); } catch { checkData = null; }

                if (checkData && checkData.data === 'EXPIRE') {
                    log(`bizId 已过期(EXPIRE)，重新触发购买…`);
                    scheduleRetry();
                    return;
                }

                S.status = 'success';
                S.bizId = bizId;
                S.lastSuccess = { text, data };
                log(`✅ 抢购成功! bizId=${bizId} (第${S.count}次) — 请在支付弹窗中完成支付！`);
                refreshUI();
                showPrompt(`抢购成功! 请在支付弹窗中完成支付`);
                return;
            } catch (checkErr) {
                log(`check 异常: ${checkErr.message}，重新触发购买…`);
                scheduleRetry();
                return;
            }
        }

        // ---- 售罄判断: bizId=null 且 soldOut=true ----
        if (data && data.data && data.data.bizId === null && data.data.soldOut === true) {
            if (!CFG.ignoreSoldOut) {
                S.status = 'failed';
                log(`❌ #${S.count} 该套餐已售罄，换个套餐试试吧！`);
                refreshUI();
                showPrompt('该套餐已售罄，换个套餐试试吧！');
                return;
            }
            log(`#${S.count} 售罄(已忽略，继续重试)`);
        }

        // ---- 失败 ----
        const why = !data ? '非JSON响应'
            : data.code === 555 ? '系统繁忙(555)'
                : (data.data && data.data.bizId === null) ? '售罄(bizId=null)'
                    : `code=${data.code}`;
        log(`#${S.count} ${why}`);

        if (stopRequested || S.count >= CFG.maxRetry) {
            S.status = 'failed';
            log(`❌ 达到上限 ${CFG.maxRetry} 次或已停止`);
            refreshUI();
            return;
        }

        scheduleRetry();
    }

    function scheduleRetry() {
        S.status = 'retrying';
        refreshUI();
        const retryDelay = 300 + Math.floor(Math.random() * 900); // 300~1200ms 随机
        log(`⏳ 第 ${S.count} 次失败，${retryDelay}ms 后重试…`);

        (async () => {
            if (stopRequested) return;
            await sleep(retryDelay);

            // 关闭所有弹窗（最多尝试 3 轮）
            for (let i = 0; i < 3; i++) {
                const closed = dismissAllDialogs();
                if (closed > 0) log(`🔄 关闭了 ${closed} 个弹窗`);
                await sleep(150);
            }

            const btn = relocateBuyButton();
            if (btn) {
                log(`🔄 自动点击 [${S.productName}] 购买按钮`);
                btn.click();
            } else {
                log('⚠️ 无法定位购买按钮');
                showPrompt('购买按钮丢失，请重新点击');
                S.status = 'waiting_user';
                refreshUI();
            }
        })();
    }

    function showPrompt(msg) {
        let tip = document.getElementById('glm-prompt');
        if (!tip) {
            tip = document.createElement('div');
            tip.id = 'glm-prompt';
            Object.assign(tip.style, {
                position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
                background: '#e17055', color: '#fff', padding: '16px 32px', borderRadius: '12px',
                fontSize: '18px', fontWeight: 'bold', zIndex: '9999999', pointerEvents: 'none',
                boxShadow: '0 4px 24px rgba(0,0,0,.5)', transition: 'opacity .5s',
            });
            document.body.appendChild(tip);
        }
        tip.textContent = msg;
        tip.style.opacity = '1';
        clearTimeout(tip._tid);
        tip._tid = setTimeout(() => { tip.style.opacity = '0'; }, 2500);
    }

    // ======================== Fetch 拦截器 ========================
    window.fetch = async function (input, init) {
        const url = typeof input === 'string' ? input : input?.url;

        // 限流拦截: 永远返回"未限流"
        if (url && url.includes(RATE_LIMIT_URL)) {
            return new Response(RATE_LIMIT_FAKE, { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        if (url && url.includes(CFG.PREVIEW) && !url.includes('batch-preview')) {
            S.captured = { url, method: init?.method || 'POST', body: init?.body, headers: extractHeaders(init?.headers) };
            extractProductId(init?.body);
            S.count++;
            S.status = 'retrying';
            log(`🎯 捕获 preview 请求 #${S.count} (Fetch)`);
            refreshUI();

            if (S.cache) {
                log('📦 返回缓存的成功响应');
                const c = S.cache;
                S.cache = null;
                recoveryAttempts = 0;
                return new Response(c.text, { status: 200, headers: { 'Content-Type': 'application/json' } });
            }

            try {
                const resp = await _fetch.apply(this, arguments);
                const cloned = resp.clone();
                const text = await cloned.text();
                await handlePreviewResponse(text);
                return resp;
            } catch (e) {
                log(`#${S.count} 网络错误: ${e.message}`);
                scheduleRetry();
                return new Response(JSON.stringify({ code: -1, msg: '网络错误' }), {
                    status: 200, headers: { 'Content-Type': 'application/json' },
                });
            }
        }

        if (url && url.includes(CFG.CHECK) && url.includes('bizId=null')) {
            return new Response(JSON.stringify({ code: -1, msg: '等待有效bizId' }), {
                status: 200, headers: { 'Content-Type': 'application/json' },
            });
        }

        return _fetch.apply(this, arguments);
    };

    // ======================== XHR 拦截器 ========================
    const _xhrOpen = XMLHttpRequest.prototype.open;
    const _xhrSend = XMLHttpRequest.prototype.send;
    const _xhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
        (this._h || (this._h = {}))[k] = v;
        return _xhrSetHeader.call(this, k, v);
    };

    XMLHttpRequest.prototype.open = function (method, url) {
        this._m = method;
        this._u = url;
        return _xhrOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function (body) {
        const url = this._u;

        // 限流拦截: XHR 层同样伪造响应
        if (typeof url === 'string' && url.includes(RATE_LIMIT_URL)) {
            fakeXHR(this, RATE_LIMIT_FAKE);
            return;
        }

        if (typeof url === 'string' && url.includes(CFG.PREVIEW) && !url.includes('batch-preview')) {
            const self = this;
            S.captured = { url, method: this._m, body, headers: this._h || {} };
            extractProductId(body);
            S.count++;
            S.status = 'retrying';
            log(`🎯 捕获 preview 请求 #${S.count} (XHR)`);
            refreshUI();

            if (S.cache) {
                const c = S.cache;
                S.cache = null;
                recoveryAttempts = 0;
                fakeXHR(self, c.text);
                return;
            }

            const fetchOpts = { method: this._m || 'POST', body, headers: this._h || {}, credentials: 'include' };

            _fetch(url, fetchOpts)
                .then(r => r.text())
                .then(async text => { await handlePreviewResponse(text); fakeXHR(self, text); })
                .catch(e => { scheduleRetry(); fakeXHR(self, JSON.stringify({ code: -1, msg: '网络错误' })); });
            return;
        }

        if (typeof url === 'string' && url.includes(CFG.CHECK) && url.includes('bizId=null')) {
            fakeXHR(this, '{"code":-1,"msg":"等待有效bizId"}');
            return;
        }

        return _xhrSend.call(this, body);
    };

    function fakeXHR(xhr, text) {
        setTimeout(() => {
            const dp = (k, v) => Object.defineProperty(xhr, k, { value: v, configurable: true });
            dp('readyState', 4); dp('status', 200); dp('statusText', 'OK');
            dp('responseText', text); dp('response', text);
            const rsc = new Event('readystatechange');
            if (typeof xhr.onreadystatechange === 'function') xhr.onreadystatechange(rsc);
            xhr.dispatchEvent(rsc);
            const load = new ProgressEvent('load');
            if (typeof xhr.onload === 'function') xhr.onload(load);
            xhr.dispatchEvent(load);
            xhr.dispatchEvent(new ProgressEvent('loadend'));
        }, 0);
    }

    // ======================== 弹窗清理 ========================

    // 关闭所有可见弹窗，抢购成功时完全跳过
    function dismissAllDialogs() {
        if (S.status === 'success') return 0;
        let closed = 0;
        const selectors = [
            '.el-dialog__wrapper', '.el-dialog', '.el-message-box',
            '.el-overlay', '.el-overlay-dialog', '.v-modal',
            '[role="dialog"]', '[class*="modal"]', '[class*="dialog"]',
        ];

        // 收集所有可见弹窗元素
        const visibleDialogs = [];
        for (const sel of selectors) {
            for (const el of document.querySelectorAll(sel)) {
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
                if (!el.offsetParent && style.position !== 'fixed') continue;

                // 跳过抢购成功后的支付弹窗
                const text = el.textContent || '';
                if (S.status === 'success' && /扫码支付|实付价格|支付宝扫码|支付即视|二维码/.test(text)) continue;

                visibleDialogs.push(el);
            }
        }

        // 去重
        const unique = [...new Set(visibleDialogs)];

        for (const dialog of unique) {
            // 1. 找关闭按钮
            const closeSelectors = [
                '.el-dialog__headerbtn', '.el-dialog__close',
                '.el-message-box__headerbtn', '.ant-modal-close',
                '[aria-label="Close"]', '[aria-label="close"]',
                '[class*="close-btn"]', '[class*="closeBtn"]',
            ];
            let didClose = false;
            for (const sel of closeSelectors) {
                const btn = dialog.querySelector(sel);
                if (btn && btn.offsetParent !== null) { btn.click(); didClose = true; break; }
            }
            if (didClose) { closed++; continue; }

            // 2. 找取消/关闭按钮
            const btns = dialog.querySelectorAll('button, [role="button"]');
            for (const btn of btns) {
                const t = (btn.textContent || '').trim();
                if (/关闭|取消|OK|Cancel|Close|确定/.test(t) && t.length < 10) { btn.click(); didClose = true; break; }
            }
            if (didClose) { closed++; continue; }

            // 3. 点遮罩层
            const overlay = dialog.closest('.el-overlay, .el-overlay-dialog, .v-modal');
            if (overlay) { overlay.click(); closed++; continue; }
        }

        // 4. 兜底：Escape 键（处理所有残余弹窗）
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
        document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', keyCode: 27, bubbles: true }));

        // 5. 清除所有遮罩层（防止灰色遮罩残留）
        for (const sel of ['.v-modal', '.el-overlay', '.el-overlay-dialog']) {
            for (const el of document.querySelectorAll(sel)) {
                el.style.display = 'none';
            }
        }

        return closed;
    }

    async function autoRecover() {
        if (recovering || recoveryAttempts >= 3 || !S.lastSuccess) return;
        recovering = true;
        recoveryAttempts++;
        dismissAllDialogs();
        await sleep(300);
        const btn = relocateBuyButton();
        if (btn) btn.click();
        recovering = false;
    }

    // ======================== 购买按钮追踪 ========================

    function buildSelector(el) {
        if (el.id) return `#${CSS.escape(el.id)}`;
        const parts = [];
        while (el && el !== document.body) {
            let seg = el.tagName.toLowerCase();
            if (el.id) { parts.unshift(`#${CSS.escape(el.id)}`); break; }
            if (el.className && typeof el.className === 'string') {
                const cls = el.className.trim().split(/\s+/).filter(c => c && !/^(v-|el-|data-)/.test(c)).slice(0, 2);
                if (cls.length) seg += '.' + cls.map(c => CSS.escape(c)).join('.');
            }
            const parent = el.parentElement;
            if (parent) {
                const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
                if (siblings.length > 1) seg += `:nth-of-type(${siblings.indexOf(el) + 1})`;
            }
            parts.unshift(seg);
            el = el.parentElement;
        }
        return parts.join(' > ');
    }

    function relocateBuyButton() {
        if (S.buyButton && document.body.contains(S.buyButton)) return S.buyButton;
        log('🔍 原始按钮引用失效，尝试重新定位…');

        // 1. Vue productId 精确定位
        if (S.targetProductId) {
            const btn = findButtonByProductId(S.targetProductId);
            if (btn) {
                log(`🔍 Vue productId 定位成功: ${S.targetProductId}`);
                S.buyButton = btn;
                S.buyButtonSelector = buildSelector(btn);
                S.buyButtonText = (btn.textContent || '').trim();
                S.productName = getProductName(btn);
                return btn;
            }
        }

        // 2. 重新扫描页面套餐
        scanVueProducts();
        if (S.targetProductId) {
            for (const p of pageProducts) {
                if (p.productId === S.targetProductId && document.body.contains(p.btn)) {
                    log(`🔍 重新扫描定位成功: ${p.productName}`);
                    S.buyButton = p.btn;
                    return p.btn;
                }
            }
        }

        // 3. CSS 选择器
        if (S.buyButtonSelector) {
            try {
                const found = document.querySelector(S.buyButtonSelector);
                if (found && document.body.contains(found) && (found.textContent || '').trim() === S.buyButtonText) {
                    S.buyButton = found;
                    return found;
                }
            } catch (e) {}
        }

        // 4. 按钮文本
        if (S.buyButtonText) {
            for (const btn of document.querySelectorAll('.buy-btn, button')) {
                if ((btn.textContent || '').trim() === S.buyButtonText) {
                    S.buyButton = btn;
                    S.buyButtonSelector = buildSelector(btn);
                    return btn;
                }
            }
        }

        log('⚠️ 所有重定位方式均失败');
        return null;
    }

    function getProductName(btn) {
        try {
            const vm = btn.__vue__;
            if (vm) {
                let cur = vm.$parent;
                for (let i = 0; i < 5 && cur; i++) {
                    const cd = cur.$props && cur.$props.cardData;
                    if (cd) {
                        const name = cd.productName || cd.title || cd.name || cd.type;
                        if (name && typeof name === 'string' && name.length < 30) return name;
                    }
                    cur = cur.$parent;
                }
            }
        } catch (e) {}
        return '未知套餐';
    }

    function setupBuyButtonTracker() {
        document.addEventListener('click', function (e) {
            const btn = e.target.closest('button, [role="button"], a');
            if (!btn) return;
            const text = (btn.textContent || '').trim();
            const isBuyBtn = btn.classList.contains('buy-btn')
                || /购买|立即购买|抢购|立即抢购|特惠订阅|继续订阅|buy|subscribe/i.test(text);
            if (!isBuyBtn) return;
            if (!S.proactive && S.status !== 'retrying' && S.status !== 'waiting_user') return;

            const vuePid = getProductIdFromVue(btn);
            S.buyButton = btn;
            S.productName = getProductName(btn);
            S.buyButtonSelector = buildSelector(btn);
            S.buyButtonText = text;
            if (vuePid) S.targetProductId = vuePid;
            log(`📌 记住购买按钮 [${S.productName}] productId=${vuePid || '?'}`);

            if (!firstClickHandled) {
                firstClickHandled = true;
                handleFirstClick();
            }
        }, true);
    }

    async function handleFirstClick() {
        const countBeforeWait = S.count;

        // 扩展验证码选择器：覆盖极验、腾讯、阿里等主流验证码
        const captchaSelectors = [
            'iframe[src*="captcha"]', 'iframe[src*="turing"]', 'iframe[src*="geetest"]',
            'iframe[src*="verify"]', 'iframe[src*="validate"]',
            '[class*="captcha"]', '[class*="Captcha"]',
            '[class*="verify"]', '[class*="Validate"]',
            '[id*="captcha"]', '[id*="Captcha"]',
            '[class*="geetest"]', '[class*="slider"]', '[class*="nc-container"]',
            '.nc_wrapper', '.nc-container', '.btn_slide',
            '#captcha', '#verify', '#geetest',
        ].join(',');

        // 是否存在可见的验证码元素
        function hasCaptcha() {
            const el = document.querySelector(captchaSelectors);
            if (!el) return false;
            // 确认可见
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) return false;
            const style = window.getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        }

        // 第一阶段：5秒窗口，同时等 preview 和验证码
        const phase1Deadline = Date.now() + 5000;
        let captchaDetected = false;

        while (Date.now() < phase1Deadline) {
            if (stopRequested || S.status === 'success') return;
            if (S.count > countBeforeWait) { log('📋 preview 已触发，拦截器接管…'); return; }
            if (!captchaDetected && hasCaptcha()) {
                captchaDetected = true;
                log('🔐 检测到验证码，等待用户完成…');
            }
            await sleep(200);
        }

        // 第二阶段：如果检测到验证码，等用户完成（最多60秒）
        if (captchaDetected && S.count === countBeforeWait) {
            log('🔐 验证码中，继续等待 preview（最长60s）…');
            const phase2Deadline = Date.now() + 60000;
            while (Date.now() < phase2Deadline) {
                if (stopRequested || S.status === 'success') return;
                if (S.count > countBeforeWait) {
                    log('📋 验证码后 preview 已触发');
                    return;
                }
                // 验证码消失了且还没触发 preview → 等待重试循环自动处理
                if (!hasCaptcha() && Date.now() > phase2Deadline - 55000) {
                    await sleep(3000);
                    if (S.count > countBeforeWait) { log('📋 验证码完成后 preview 已触发'); return; }
                    log('⚠️ 验证码消失但 preview 未触发，等待下次自动重试');
                    return;
                }
                await sleep(300);
            }
            log('⚠️ 验证码等待超时(60s)，等待下次自动重试');
            return;
        }

        // 第三阶段：5秒内既没验证码也没 preview → 点击可能没生效
        if (S.count === countBeforeWait && !stopRequested && S.status !== 'success') {
            log('⚠️ 点击后5秒无响应，尝试重新点击');
            retryClick();
        }
    }

    // 兜底重试点击
    let clickRetryCount = 0;
    const MAX_CLICK_RETRY = 5;
    function retryClick() {
        if (stopRequested || S.status === 'success') return;
        if (clickRetryCount >= MAX_CLICK_RETRY) {
            log(`⚠️ 兜底重试已达上限(${MAX_CLICK_RETRY}次)，走 scheduleRetry 流程`);
            clickRetryCount = 0;
            scheduleRetry();
            return;
        }
        clickRetryCount++;
        dismissAllDialogs();
        const btn = relocateBuyButton();
        if (btn) {
            log(`🔄 兜底重试(${clickRetryCount}/${MAX_CLICK_RETRY}): 重新点击 [${S.productName || '购买'}]`);
            btn.click();
            S.status = 'retrying';
            refreshUI();
            // 重新进入验证码检测
            handleFirstClick();
        } else {
            log('⚠️ 兜底重试失败: 按钮定位不到');
            clickRetryCount = 0;
            scheduleRetry();
        }
    }

    // ======================== 面板选套餐启动抢购 ========================
    async function startRushByProductId(productId) {
        if (!productId) { log('⚠️ 请先选择套餐'); return; }

        // 重新扫描确保最新
        scanVueProducts();
        const product = pageProducts.find(p => p.productId === productId);
        if (!product) { log(`⚠️ 未找到套餐 ${productId}`); return; }

        S.proactive = true;
        stopRequested = false;
        firstClickHandled = true;   // 提前设为 true，防止 btn.click() 冒泡触发 setupBuyButtonTracker 的 handleFirstClick
        clickRetryCount = 0;
        S.count = 0;
        S.bizId = null;
        S.lastSuccess = null;
        S.targetProductId = productId;
        S.productName = product.productName;
        S.buyButtonText = (product.btn.textContent || '').trim();
        S.buyButtonSelector = buildSelector(product.btn);

        log(`🚀 抢购 [${product.productName}] ¥${product.salePrice}/${product.unit || '?'} productId=${productId}`);

        // 直接点击购买按钮
        const btn = findButtonByProductId(productId) || product.btn;
        if (!btn) { log('⚠️ 购买按钮未找到'); return; }
        S.buyButton = btn;
        btn.click();
        log(`📌 已点击 [${product.productName}] 购买按钮`);

        S.status = 'retrying';
        refreshUI();

        // 注意：此处不调用 handleFirstClick()
        // 因为 startRushByProductId 是自动点击，重试循环已由拦截器 + scheduleRetry 接管
        // handleFirstClick 的5秒等待+兜底重试会与 scheduleRetry 双重触发导致"5秒无响应"日志
    }

    // ======================== 主动抢购模式（兼容旧流程）========================
    async function startProactive() {
        S.proactive = true;
        stopRequested = false;
        firstClickHandled = false;
        S.buyButton = null;
        S.productName = '';
        S.buyButtonSelector = '';
        S.buyButtonText = '';
        S.targetProductId = '';
        log('🚀 主动抢购模式启动 — 请点击要购买的套餐');
        S.status = 'waiting_user';
        refreshUI();
        showPrompt('请点击要购买的套餐');
    }

    function stopAll() {
        stopRequested = true;
        S.proactive = false;
        S.status = 'idle';
        S.count = 0;
        S.targetTime = null;
        S.scheduledProductId = null;
        if (S.timerId) { clearTimeout(S.timerId); S.timerId = null; }
        if (S.syncIntervalId) { clearInterval(S.syncIntervalId); S.syncIntervalId = null; }
        if (S.heartbeatId) { clearInterval(S.heartbeatId); S.heartbeatId = null; }
        if (S.countdownId) { clearInterval(S.countdownId); S.countdownId = null; }
        log('⏹ 已停止');
        refreshUI();
    }

    // ======================== 时间同步 ========================

    // 获取服务器时间偏移（单次采样）
    async function sampleOffset() {
        // 策略1: 目标站点响应头 Date
        try {
            const t0 = Date.now();
            const resp = await _fetch(location.origin + '/favicon.ico?_t=' + t0, {
                method: 'HEAD', cache: 'no-store', credentials: 'omit'
            });
            const t1 = Date.now();
            const dateStr = resp.headers.get('Date');
            if (dateStr) {
                const serverMs = new Date(dateStr).getTime();
                const localMid = (t0 + t1) / 2;
                const rtt = t1 - t0;
                // 只在 RTT 合理时采纳（<2s）
                if (rtt < 2000 && !isNaN(serverMs)) {
                    return { offset: serverMs - localMid, rtt, source: 'site' };
                }
            }
        } catch {}

        // 策略2: worldtimeapi.org
        try {
            const t0 = Date.now();
            const resp = await _fetch('https://worldtimeapi.org/api/timezone/Asia/Shanghai', {
                cache: 'no-store'
            });
            const t1 = Date.now();
            const data = await resp.json();
            if (data && data.unixtime) {
                const serverMs = data.unixtime * 1000 + (data.raw_offset || 0);
                const localMid = (t0 + t1) / 2;
                const rtt = t1 - t0;
                if (rtt < 3000) {
                    return { offset: serverMs - localMid, rtt, source: 'worldtimeapi' };
                }
            }
        } catch {}

        return null;
    }

    let syncing = false; // 并发锁
    // 执行一次时间同步（多次采样取中位数）
    async function syncTime() {
        if (syncing) return; // 上一轮还没结束，跳过
        syncing = true;
        try {
            const samples = [];
            for (let i = 0; i < 3; i++) {
                const r = await sampleOffset();
                if (r) samples.push(r);
            }
            if (samples.length === 0) {
                S.lastSyncOk = false;
                return;
            }
            // 按 RTT 排序取 RTT 最低的采样（网络越快，精度越高）
            samples.sort((a, b) => a.rtt - b.rtt);
            const best = samples[0];
            // 用指数平滑避免跳变
            const alpha = S.syncCount === 0 ? 1.0 : 0.3;
            S.timeOffset = S.timeOffset * (1 - alpha) + best.offset * alpha;
            S.syncCount++;
            S.lastSyncOk = true;
            log(`⏱ 时间同步 #${S.syncCount}: 偏移${S.timeOffset >= 0 ? '+' : ''}${Math.round(S.timeOffset)}ms RTT=${best.rtt}ms (${best.source})`);
        } finally {
            syncing = false;
        }
    }

    // 启动同步循环（每10秒）
    function startSyncLoop() {
        stopSyncLoop();
        // 立即执行一次
        syncTime();
        S.syncIntervalId = setInterval(syncTime, 10000);
    }

    function stopSyncLoop() {
        if (S.syncIntervalId) { clearInterval(S.syncIntervalId); S.syncIntervalId = null; }
    }

    // ======================== 心跳保活 ========================

    function startHeartbeat() {
        stopHeartbeat();
        S.heartbeatId = setInterval(async () => {
            // 1. 发轻量请求保 session
            try {
                await _fetch(location.origin + '/favicon.ico?_hb=' + Date.now(), {
                    method: 'HEAD', cache: 'no-store', credentials: 'include'
                });
            } catch {}

            // 2. 检查 Vue 按钮引用是否还在 DOM
            if (S.buyButton && !document.body.contains(S.buyButton)) {
                log('⚠️ 心跳检测: 购买按钮引用失效，尝试重新定位');
                const btn = relocateBuyButton();
                if (btn) {
                    log('✅ 心跳检测: 按钮重定位成功');
                } else {
                    log('⚠️ 心跳检测: 按钮重定位失败，将在下次扫描重试');
                }
            }

            // 3. 定时器状态检查
            if (!S.targetTime) return;
            const serverNow = Date.now() - S.timeOffset;
            const remain = S.targetTime - serverNow;
            if (remain < -60000) {
                log('❌ 心跳检测: 定时已过期超过60秒，可能漏触发');
                stopHeartbeat();
                stopSyncLoop();
            }
        }, 30000); // 每30秒心跳
    }

    function stopHeartbeat() {
        if (S.heartbeatId) { clearInterval(S.heartbeatId); S.heartbeatId = null; }
    }

    // ======================== 倒计时显示 ========================

    function startCountdown() {
        stopCountdown();
        updateCountdownDisplay();
        // 用 setInterval 驱动更新（即使 tab 在后台也能被保活请求唤醒）
        S.countdownId = setInterval(updateCountdownDisplay, 1000);
    }

    function stopCountdown() {
        if (S.countdownId) { clearInterval(S.countdownId); S.countdownId = null; }
        const el = document.getElementById('glm-countdown');
        if (el) el.textContent = '';
    }

    function updateCountdownDisplay() {
        const el = document.getElementById('glm-countdown');
        if (!el || !S.targetTime) return;
        const serverNow = Date.now() - S.timeOffset;
        const remain = S.targetTime - serverNow;
        if (remain <= 0) {
            el.textContent = '⏰ 触发中…';
            return;
        }
        const h = Math.floor(remain / 3600000);
        const m = Math.floor((remain % 3600000) / 60000);
        const s = Math.floor((remain % 60000) / 1000);
        const offsetStr = S.lastSyncOk ? `偏移${S.timeOffset >= 0 ? '+' : ''}${Math.round(S.timeOffset)}ms` : '未同步';
        const parts = [];
        if (h > 0) parts.push(`${h}h`);
        parts.push(`${String(m).padStart(2, '0')}m`);
        parts.push(`${String(s).padStart(2, '0')}s`);
        el.textContent = `⏰ ${parts.join('')} | ${offsetStr} | 同步${S.syncCount}次`;
    }

    // ======================== 定时触发 (v2: 精确定时) ========================

    function scheduleAt(timeStr, productId) {
        // 清理旧的定时器
        if (S.timerId) { clearTimeout(S.timerId); S.timerId = null; }
        stopSyncLoop();
        stopHeartbeat();
        stopCountdown();

        const parts = timeStr.split(':').map(Number);
        const now = new Date();
        const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parts[0], parts[1], parts[2] || 0);
        if (target <= now) { log('⚠️ 目标时间已过'); return; }

        S.targetTime = target.getTime();
        S.scheduledProductId = productId || null;
        S.status = 'scheduled';

        // 提前记住套餐名和按钮引用
        if (productId) {
            scanVueProducts();
            const product = pageProducts.find(p => p.productId === productId);
            if (product) {
                S.productName = product.productName;
                S.targetProductId = productId;
                S.buyButton = product.btn;
                S.buyButtonSelector = buildSelector(product.btn);
                S.buyButtonText = (product.btn.textContent || '').trim();
            }
        }

        const ms = target - now;
        log(`⏰ 定时设定: ${timeStr} (${Math.ceil(ms / 1000)}秒后) [${productId || '手动选择'}]`);

        // 启动时间同步循环（每10秒）
        startSyncLoop();

        // 启动心跳保活
        startHeartbeat();

        // 启动倒计时显示
        startCountdown();

        // 精确触发逻辑：先用粗粒度 setTimeout，到点前 5 秒切换到高精度轮询
        const fireIn = ms - 5000;
        if (fireIn > 0) {
            S.timerId = setTimeout(() => {
                S.timerId = null;
                // 进入最后 5 秒，切换到 50ms 精确轮询
                preciseCountdown();
            }, fireIn);
        } else {
            // 距离目标不足5秒，直接进入精确轮询
            preciseCountdown();
        }

        refreshUI();
    }

    // 最后阶段精确轮询（50ms 精度）
    function preciseCountdown() {
        const poll = () => {
            const serverNow = Date.now() - S.timeOffset;
            const remain = S.targetTime - serverNow;
            if (remain <= 0) {
                const triggerDelay = 500 + Math.floor(Math.random() * 300); // 500~800ms 随机延迟
                log(`⏰ 时间到! 额外随机等待 ${triggerDelay}ms 后启动抢购!`);
                setTimeout(() => {
                    stopSyncLoop();
                    stopHeartbeat();
                    S.targetTime = null;
                    if (S.scheduledProductId) {
                        startRushByProductId(S.scheduledProductId);
                    } else {
                        startProactive();
                    }
                }, triggerDelay);
                return;
            }
            // 还没到，50ms 后再检查
            S.timerId = setTimeout(poll, 50);
        };
        poll();
    }

    // ======================== 浮动控制面板 ========================
    function createPanel() {
        const panel = document.createElement('div');
        panel.id = 'glm-rush';
        panel.innerHTML = `
<style>
#glm-rush{position:fixed;top:10px;right:10px;width:360px;background:#1a1a2e;color:#e0e0e0;
  border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.6);z-index:999999;
  font:13px/1.5 Consolas,'Courier New',monospace;user-select:none}
#glm-rush *{box-sizing:border-box;margin:0;padding:0}
.glm-hd{background:linear-gradient(135deg,#0f3460,#16213e);padding:9px 14px;
  border-radius:12px 12px 0 0;display:flex;justify-content:space-between;align-items:center;cursor:move}
.glm-hd b{font-size:14px;letter-spacing:.5px}
.glm-mn{background:none;border:none;color:#aaa;cursor:pointer;font-size:20px;line-height:1;padding:0 4px}
.glm-mn:hover{color:#fff}
.glm-bd{padding:12px 14px 14px}
.glm-st{padding:8px;border-radius:8px;text-align:center;font-weight:700;margin-bottom:10px;transition:background .3s}
.glm-st-idle{background:#2d3436}
.glm-st-scheduled{background:#0f3460;animation:glm-pulse 2s infinite}
.glm-st-retrying{background:#e17055;animation:glm-pulse 1s infinite}
.glm-st-waiting_user{background:#6c5ce7;animation:glm-pulse 1.5s infinite}
.glm-st-success{background:#00b894}
.glm-st-failed{background:#d63031}
@keyframes glm-pulse{50%{opacity:.7}}
.glm-cap{font-size:11px;padding:5px 8px;background:#2d3436;border-radius:6px;margin-bottom:10px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.glm-sec{margin-bottom:10px}
.glm-sec-title{font-size:11px;color:#636e72;margin-bottom:6px;font-weight:700;letter-spacing:.5px}
.glm-products{display:flex;flex-direction:column;gap:4px;margin-bottom:8px}
.glm-p-item{display:flex;align-items:center;gap:8px;padding:6px 8px;background:#2d3436;border-radius:6px;cursor:pointer;transition:background .2s}
.glm-p-item:hover{background:#353b48}
.glm-p-item.selected{background:#0f3460;border:1px solid #0984e3}
.glm-p-radio{width:14px;height:14px;border-radius:50%;border:2px solid #636e72;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.glm-p-item.selected .glm-p-radio{border-color:#0984e3}
.glm-p-item.selected .glm-p-radio::after{content:'';width:8px;height:8px;border-radius:50%;background:#0984e3}
.glm-p-info{flex:1;display:flex;justify-content:space-between;align-items:center}
.glm-p-name{font-weight:700;font-size:12px}
.glm-p-price{font-size:11px;color:#b2bec3}
.glm-row{display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:12px;flex-wrap:wrap}
.glm-row input[type=number],.glm-row input[type=time]{
  width:80px;padding:4px 6px;border:1px solid #444;border-radius:4px;
  background:#2d3436;color:#fff;text-align:center;font-size:12px}
.glm-btns{display:flex;gap:8px;margin-bottom:10px}
.glm-btns button{flex:1;padding:8px;border:none;border-radius:6px;cursor:pointer;
  font-weight:700;font-size:12px;color:#fff;transition:opacity .2s}
.glm-btns button:hover{opacity:.85}
.glm-btns button:disabled{opacity:.4;cursor:not-allowed}
.glm-b-go{background:#0984e3}
.glm-b-stop{background:#d63031}
.glm-b-time{background:#6c5ce7}
.glm-b-scan{background:#00b894}
.glm-logs{max-height:150px;overflow-y:auto;background:#0d1117;border-radius:6px;
  padding:6px 8px;font-size:11px;line-height:1.7}
.glm-logs div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.glm-logs::-webkit-scrollbar{width:4px}
.glm-logs::-webkit-scrollbar-thumb{background:#444;border-radius:2px}
.glm-tip{font-size:10px;color:#b2bec3;padding:4px 0 4px;line-height:1.4}
.glm-link{text-align:center;padding:8px 0;margin-bottom:8px}
.glm-link a{color:#74b9ff;font-size:14px;font-weight:700;text-decoration:underline}
.glm-link a:hover{color:#0984e3}
</style>
<div class="glm-hd" id="glm-drag">
  <b>GLM 抢购助手 v6.0</b>
  <button class="glm-mn" id="glm-min">−</button>
</div>
<div class="glm-bd" id="glm-bd">
  <div class="glm-st glm-st-idle" id="glm-st">⏳ 等待中</div>
  <div class="glm-link"><a href="https://my.feishu.cn/wiki/X978w20xSikUJGkTVqhcMWKcnQg" target="_blank">📖 使用文档 & 帮助中心</a></div>
  <div class="glm-cap" id="glm-cap">📡 请先扫描套餐</div>
  <div class="glm-cap" id="glm-countdown" style="color:#74b9ff;text-align:center"></div>

  <div class="glm-sec">
    <div class="glm-sec-title">📦 套餐选择</div>
    <div class="glm-products" id="glm-products">
      <div class="glm-tip">点击下方「扫描套餐」加载当前页面套餐</div>
    </div>
    <button class="glm-b-scan" id="glm-scan" style="width:100%;padding:6px;border:none;border-radius:6px;color:#fff;font-weight:700;font-size:12px;cursor:pointer">🔄 扫描套餐</button>
  </div>

  <div class="glm-sec">
    <div class="glm-sec-title">⏰ 定时抢购</div>
    <div class="glm-row">
      <input type="time" id="glm-time" step="1" style="flex:1">
      <button class="glm-b-time" id="glm-time-set" style="padding:6px 12px;border:none;border-radius:6px;color:#fff;font-weight:700;font-size:12px;cursor:pointer">定时抢购</button>
    </div>
  </div>

  <div class="glm-sec">
    <div class="glm-sec-title">⚙️ 设置</div>
    <div class="glm-row">
      <span>上限</span><input type="number" id="glm-max" value="${CFG.maxRetry}" min="10" max="9999" step="10"><span>次</span>
    </div>
    <div class="glm-row" style="margin-top:6px">
      <label style="cursor:pointer;display:flex;align-items:center;gap:6px;font-size:12px">
        <input type="checkbox" id="glm-ignore-soldout"> 售罄仍继续重试(测试用)
      </label>
    </div>
  </div>

  <div class="glm-btns">
    <button class="glm-b-go" id="glm-go" disabled>▶ 立即抢购</button>
    <button class="glm-b-stop" id="glm-stop" style="display:none">■ 停止</button>
  </div>

  <div class="glm-logs" id="glm-logs"></div>
</div>`;
        document.body.appendChild(panel);

        const $ = id => document.getElementById(id);

        // 扫描套餐按钮
        $('glm-scan').onclick = function () {
            const products = scanVueProducts();
            renderProducts(products);
            log(`📦 扫描到 ${products.length} 个套餐`);
        };

        // 立即抢购按钮
        $('glm-go').onclick = function () {
            const sel = document.querySelector('.glm-p-item.selected');
            if (!sel) { showPrompt('请先选择套餐'); return; }
            const pid = sel.dataset.pid;
            startRushByProductId(pid);
        };

        $('glm-stop').onclick = stopAll;

        $('glm-max').onchange = function () {
            CFG.maxRetry = Math.max(10, +this.value || 300);
        };

        $('glm-ignore-soldout').onchange = function () {
            CFG.ignoreSoldOut = this.checked;
            log(`⚙️ 售罄继续重试: ${CFG.ignoreSoldOut ? '开启' : '关闭'}`);
        };

        // 定时抢购
        $('glm-time-set').onclick = function () {
            const v = $('glm-time').value;
            if (!v) { showPrompt('请先设定时间'); return; }
            const sel = document.querySelector('.glm-p-item.selected');
            const pid = sel ? sel.dataset.pid : null;
            if (!pid) { showPrompt('请先选择套餐'); return; }
            scheduleAt(v, pid);
        };

        $('glm-min').onclick = function () {
            const bd = $('glm-bd');
            const hidden = bd.style.display === 'none';
            bd.style.display = hidden ? '' : 'none';
            this.textContent = hidden ? '−' : '+';
        };

        let sx, sy, sl, st;
        $('glm-drag').onmousedown = function (e) {
            sx = e.clientX; sy = e.clientY;
            const rect = panel.getBoundingClientRect();
            sl = rect.left; st = rect.top;
            const onMove = function (e) {
                panel.style.left = (sl + e.clientX - sx) + 'px';
                panel.style.top = (st + e.clientY - sy) + 'px';
                panel.style.right = 'auto';
            };
            const onUp = function () {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        };

        log('v6.0 已加载 (面板选套餐版)');
        setInterval(() => { if (S.lastSuccess && !recovering && recoveryAttempts < 3) { dismissAllDialogs(); } }, 500);
        setupBuyButtonTracker();

        // 自动扫描（延迟等 Vue 渲染完成）
        setTimeout(() => {
            const products = scanVueProducts();
            if (products.length > 0) {
                renderProducts(products);
                log(`📦 自动扫描到 ${products.length} 个套餐`);
            }
        }, 2000);
    }

    // 渲染套餐列表到面板
    function renderProducts(products) {
        const container = document.getElementById('glm-products');
        if (!container) return;
        container.innerHTML = '';

        if (products.length === 0) {
            container.innerHTML = '<div class="glm-tip">未找到套餐，请确认页面已加载</div>';
            return;
        }

        for (const p of products) {
            const item = document.createElement('div');
            item.className = 'glm-p-item';
            item.dataset.pid = p.productId;
            item.innerHTML = `
                <div class="glm-p-radio"></div>
                <div class="glm-p-info">
                    <span class="glm-p-name">${p.productName}</span>
                    <span class="glm-p-price">¥${p.salePrice}/${p.unit || '?'}</span>
                </div>`;
            item.onclick = function () {
                container.querySelectorAll('.glm-p-item').forEach(el => el.classList.remove('selected'));
                this.classList.add('selected');
                const goBtn = document.getElementById('glm-go');
                if (goBtn) goBtn.disabled = false;
                document.getElementById('glm-cap').textContent = `📌 已选: ${p.productName} ¥${p.salePrice}/${p.unit || '?'}`;
            };
            container.appendChild(item);
        }

        // 如果之前已选中，恢复选中状态
        if (S.targetProductId) {
            const prev = container.querySelector(`[data-pid="${S.targetProductId}"]`);
            if (prev) {
                prev.classList.add('selected');
                const goBtn = document.getElementById('glm-go');
                if (goBtn) goBtn.disabled = false;
            }
        }
    }

    function refreshUI() {
        const stEl = document.getElementById('glm-st');
        if (!stEl) return;
        stEl.className = 'glm-st glm-st-' + S.status;

        const statusText = {
            idle: '⏳ 等待中',
            scheduled: '⏰ 定时等待中',
            retrying: `🔄 抢购中… #${S.count}`,
            waiting_user: `👆 请点击购买按钮${S.productName ? ' [' + S.productName + ']' : ''}`,
            success: `✅ 成功! bizId=${S.bizId} — 请支付!`,
            failed: `❌ 失败 (${S.count}次)`,
        };
        stEl.textContent = statusText[S.status] || S.status;

        const capEl = document.getElementById('glm-cap');
        if (capEl) {
            if (S.status === 'success') {
                capEl.textContent = `✅ bizId=${S.bizId} — 请在支付弹窗中完成支付`;
            } else if (S.status === 'scheduled') {
                capEl.textContent = `📌 定时: [${S.productName || '已选套餐'}] 等待触发…`;
            } else if (S.captured) {
                capEl.textContent = `📡 已捕获: ${S.captured.method} #${S.count}`;
            } else if (S.targetProductId) {
                capEl.textContent = `📌 目标: [${S.productName}] ${S.targetProductId}`;
            }
        }

        const goBtn = document.getElementById('glm-go');
        const stopBtn = document.getElementById('glm-stop');
        if (goBtn && stopBtn) {
            const isRunning = S.status === 'retrying' || S.status === 'waiting_user' || S.status === 'scheduled';
            goBtn.style.display = isRunning ? 'none' : '';
            stopBtn.style.display = isRunning ? '' : 'none';
            // 停止后恢复立即抢购按钮状态
            if (!isRunning) {
                const hasSelection = document.querySelector('.glm-p-item.selected');
                goBtn.disabled = !hasSelection;
            }
        }

        // 定时器信息
        const timerInfo = document.getElementById('glm-timer-info');
        if (timerInfo && S.timerId) {
            timerInfo.textContent = '⏰ 已设定';
        } else if (timerInfo) {
            timerInfo.textContent = '';
        }
    }

    function refreshLog() {
        const el = document.getElementById('glm-logs');
        if (!el) return;
        const last = S.logs[S.logs.length - 1];
        if (last) {
            const div = document.createElement('div');
            div.textContent = last;
            el.appendChild(div);
            el.scrollTop = el.scrollHeight;
        }
    }

    // ======================== 启动 ========================
    if (document.body) {
        createPanel();
    } else {
        document.addEventListener('DOMContentLoaded', createPanel);
    }

})();
