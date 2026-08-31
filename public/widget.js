(function () {
  'use strict';

  if (window.__hbWidgetLoaded) return;
  window.__hbWidgetLoaded = true;

  var API_URL = 'https://hakuba-bot.onrender.com/api/chat';
  var HISTORY_URL = 'https://hakuba-bot.onrender.com/api/chat/history';
  var DARK = '#1c1c1e';
  var GOLD = '#b8975a';

  // 多語言介面文字
  var I18N = {
    en: {
      title: 'Hakuba Concierge',
      status: '● Online',
      placeholder: 'Ask me anything...',
      welcome: 'Welcome to The 1/3rd Hakuba! 🏔️\nI\'m your AI concierge — ask me anything about the villa or Hakuba area in any language.',
      powered: 'The 1/3rd Hakuba · AI Concierge',
      error: 'Connection error. Please check your internet and try again.',
      quick: [
        { label: '🚌 Book Transfer', text: 'book transfer' },
        { label: '📅 Check Availability', text: 'check availability' },
        { label: '🧑‍💼 Talk to Staff', text: 'human' },
      ],
    },
    zh: {
      title: 'Hakuba 禮賓助理',
      status: '● 線上',
      placeholder: '有什麼需要幫忙嗎...',
      welcome: '歡迎光臨 The 1/3rd Hakuba！🏔️\n我是您的 AI 禮賓助理，歡迎以任何語言詢問關於別墅或白馬地區的問題。',
      powered: 'The 1/3rd Hakuba · AI 禮賓',
      error: '連線失敗，請確認網路後再試。',
      quick: [
        { label: '🚌 接送預約', text: '接送預約' },
        { label: '📅 查詢空房', text: '請問有空房嗎？' },
        { label: '🧑‍💼 真人客服', text: '真人' },
      ],
    },
    ja: {
      title: 'Hakuba コンシェルジュ',
      status: '● オンライン',
      placeholder: '何でもお気軽に...',
      welcome: 'The 1/3rd Hakuba へようこそ！🏔️\nAI コンシェルジュです。別荘や白馬エリアについて何でもご質問ください。',
      powered: 'The 1/3rd Hakuba · AI コンシェルジュ',
      error: '接続エラーが発生しました。再度お試しください。',
      quick: [
        { label: '🚌 送迎予約', text: '送迎予約' },
        { label: '📅 空室確認', text: '空室確認' },
        { label: '🧑‍💼 スタッフ対応', text: 'スタッフ' },
      ],
    },
  };

  function detectLang() {
    var html = (document.documentElement.lang || '').toLowerCase().slice(0, 2);
    if (I18N[html]) return html;
    var path = window.location.pathname;
    if (/\/(ja|jp)\//.test(path)) return 'ja';
    if (/\/(zh|tw|cn)\//.test(path)) return 'zh';
    return 'en';
  }

  var lang = detectLang();
  var T = I18N[lang];

  // Session ID 存在 localStorage；判斷是否回訪
  var SESSION_KEY = 'hb_webchat_session';
  var isNewSession = !localStorage.getItem(SESSION_KEY);
  var sessionId = localStorage.getItem(SESSION_KEY);
  if (!sessionId) {
    sessionId = 'web:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    localStorage.setItem(SESSION_KEY, sessionId);
  }

  // CSS
  var style = document.createElement('style');
  style.textContent = [
    '#hb-btn{position:fixed;bottom:24px;right:24px;width:56px;height:56px;background:' + DARK + ';border-radius:50%;cursor:pointer;z-index:9998;box-shadow:0 4px 16px rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center;border:none;transition:transform .2s}',
    '#hb-btn:hover{transform:scale(1.08)}',
    '#hb-win{position:fixed;bottom:88px;right:24px;width:360px;max-width:calc(100vw - 32px);height:520px;max-height:calc(100vh - 112px);background:#fff;border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,.2);z-index:9999;display:none;flex-direction:column;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px}',
    '#hb-win.hb-open{display:flex}',
    '#hb-head{background:' + DARK + ';color:#fff;padding:14px 16px;display:flex;align-items:center;gap:10px;flex-shrink:0}',
    '#hb-avatar{width:36px;height:36px;border-radius:50%;background:' + GOLD + ';display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0}',
    '#hb-info{flex:1;min-width:0}',
    '#hb-name{font-size:15px;font-weight:600}',
    '#hb-status{font-size:11px;color:#7ee07e;margin-top:2px}',
    '#hb-x{background:none;border:none;color:rgba(255,255,255,.6);cursor:pointer;font-size:20px;padding:4px;line-height:1;flex-shrink:0}',
    '#hb-x:hover{color:#fff}',
    '#hb-msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;background:#f5f5f7}',
    '.hb-m{max-width:84%;padding:10px 14px;border-radius:16px;line-height:1.5;word-break:break-word;white-space:pre-wrap}',
    '.hb-bot{background:#fff;color:#1c1c1e;border-bottom-left-radius:4px;align-self:flex-start;box-shadow:0 1px 4px rgba(0,0,0,.08)}',
    '.hb-user{background:' + DARK + ';color:#fff;border-bottom-right-radius:4px;align-self:flex-end}',
    '#hb-typing{display:flex;gap:4px;align-items:center;padding:12px 14px;background:#fff;border-radius:16px;border-bottom-left-radius:4px;align-self:flex-start;box-shadow:0 1px 4px rgba(0,0,0,.08)}',
    '.hb-dot{width:7px;height:7px;border-radius:50%;background:#bbb;animation:hb-bounce 1.2s infinite}',
    '.hb-dot:nth-child(2){animation-delay:.2s}',
    '.hb-dot:nth-child(3){animation-delay:.4s}',
    '@keyframes hb-bounce{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-5px)}}',
    '#hb-foot{display:flex;gap:8px;padding:10px 12px;background:#fff;border-top:1px solid #eee;flex-shrink:0;align-items:flex-end}',
    '#hb-inp{flex:1;border:1.5px solid #e0e0e0;border-radius:22px;padding:9px 14px;font-size:16px;outline:none;resize:none;font-family:inherit;line-height:1.4;max-height:90px;overflow-y:auto}',
    '#hb-inp:focus{border-color:' + GOLD + '}',
    '#hb-send{width:38px;height:38px;border-radius:50%;background:' + DARK + ';border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:opacity .2s}',
    '#hb-send:hover{opacity:.8}',
    '#hb-quick{display:flex;gap:6px;padding:8px 12px 4px;background:#fff;flex-wrap:wrap;flex-shrink:0;border-top:1px solid #f0f0f0}',
    '.hb-qbtn{background:#fff;border:1.5px solid ' + GOLD + ';color:#1c1c1e;border-radius:20px;padding:5px 12px;font-size:12px;cursor:pointer;white-space:nowrap;font-family:inherit;transition:background .15s,color .15s;line-height:1.4}',
    '.hb-qbtn:hover{background:' + GOLD + ';color:#fff}',
    '#hb-powered{text-align:center;font-size:11px;color:#ccc;padding:5px;background:#fff;flex-shrink:0}',
    '@media(max-width:480px){#hb-win{bottom:0;right:0;left:0;width:100%;max-width:100%;height:88dvh;max-height:88dvh;border-radius:16px 16px 0 0}#hb-btn{bottom:16px;right:16px}}',
  ].join('');
  document.head.appendChild(style);

  // HTML
  var wrap = document.createElement('div');
  wrap.innerHTML =
    '<button id="hb-btn" aria-label="Chat with Hakuba Concierge">' +
      '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="' + GOLD + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>' +
      '</svg>' +
    '</button>' +
    '<div id="hb-win" role="dialog" aria-label="Hakuba Concierge Chat">' +
      '<div id="hb-head">' +
        '<div id="hb-avatar">🏔️</div>' +
        '<div id="hb-info"><div id="hb-name">' + T.title + '</div><div id="hb-status">' + T.status + '</div></div>' +
        '<button id="hb-x" aria-label="Close">✕</button>' +
      '</div>' +
      '<div id="hb-msgs"></div>' +
      '<div id="hb-quick">' +
        T.quick.map(function(q) {
          return '<button class="hb-qbtn" data-text="' + q.text + '">' + q.label + '</button>';
        }).join('') +
      '</div>' +
      '<div id="hb-foot">' +
        '<textarea id="hb-inp" rows="1" placeholder="' + T.placeholder + '"></textarea>' +
        '<button id="hb-send" aria-label="Send">' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="white"><path d="M22 2L11 13M22 2L15 22L11 13L2 9L22 2Z"/></svg>' +
        '</button>' +
      '</div>' +
      '<div id="hb-powered">' + T.powered + '</div>' +
    '</div>';
  document.body.appendChild(wrap);

  var btn = document.getElementById('hb-btn');
  var win = document.getElementById('hb-win');
  var closeBtn = document.getElementById('hb-x');
  var msgs = document.getElementById('hb-msgs');
  var inp = document.getElementById('hb-inp');
  var sendBtn = document.getElementById('hb-send');

  var isOpen = false;
  var isWaiting = false;
  var knownMsgCount = 0; // 已同步的 DB 訊息數，用於偵測新訊息
  var pollTimer = null;

  var WELCOME = T.welcome;

  function loadHistory() {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', HISTORY_URL + '?sessionId=' + encodeURIComponent(sessionId));
    xhr.timeout = 12000;
    var done = false;
    function fallback() { if (!done) { done = true; addMsg('bot', WELCOME); } }
    xhr.onload = function() {
      done = true;
      try {
        var data = JSON.parse(xhr.responseText);
        if (data.messages && data.messages.length > 0) {
          data.messages.forEach(function(m) {
            addMsg(m.role === 'user' ? 'user' : 'bot', m.content);
          });
          knownMsgCount = data.messages.length;
          msgs.scrollTop = msgs.scrollHeight;
        } else {
          addMsg('bot', WELCOME);
        }
      } catch(e) { addMsg('bot', WELCOME); }
    };
    xhr.onerror = xhr.ontimeout = fallback;
    xhr.send();
  }

  function pollNewMessages() {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', HISTORY_URL + '?sessionId=' + encodeURIComponent(sessionId));
    xhr.timeout = 8000;
    xhr.onload = function() {
      try {
        var data = JSON.parse(xhr.responseText);
        var list = data.messages || [];
        if (list.length > knownMsgCount) {
          list.slice(knownMsgCount).forEach(function(m) {
            if (m.role === 'assistant') addMsg('bot', m.content);
          });
          knownMsgCount = list.length;
        }
      } catch(e) {}
    };
    xhr.send();
  }

  function open() {
    isOpen = true;
    win.classList.add('hb-open');
    inp.focus();
    if (msgs.children.length === 0) {
      if (isNewSession) {
        addMsg('bot', WELCOME);
      } else {
        loadHistory();
      }
    }
    if (!pollTimer) pollTimer = setInterval(pollNewMessages, 5000);
  }

  function close() {
    isOpen = false;
    win.classList.remove('hb-open');
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function addMsg(type, text) {
    var d = document.createElement('div');
    d.className = 'hb-m hb-' + type;
    d.textContent = text;
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function showTyping() {
    var d = document.createElement('div');
    d.id = 'hb-typing';
    d.innerHTML = '<div class="hb-dot"></div><div class="hb-dot"></div><div class="hb-dot"></div>';
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function hideTyping() {
    var t = document.getElementById('hb-typing');
    if (t) t.remove();
  }

  function send() {
    var text = inp.value.trim();
    if (!text || isWaiting) return;
    inp.value = '';
    inp.style.height = 'auto';
    addMsg('user', text);
    isWaiting = true;
    sendBtn.style.opacity = '0.4';
    showTyping();

    var xhr = new XMLHttpRequest();
    xhr.open('POST', API_URL);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.timeout = 60000; // Render free tier 可能需要喚醒
    xhr.onload = function () {
      hideTyping();
      try {
        var data = JSON.parse(xhr.responseText);
        addMsg('bot', data.reply || 'Sorry, something went wrong.');
        knownMsgCount += 2; // user message + bot reply
      } catch (e) {
        addMsg('bot', 'Error parsing response. Please try again.');
      }
      isWaiting = false;
      sendBtn.style.opacity = '1';
    };
    xhr.onerror = xhr.ontimeout = function () {
      hideTyping();
      addMsg('bot', T.error);
      isWaiting = false;
      sendBtn.style.opacity = '1';
    };
    xhr.send(JSON.stringify({ sessionId: sessionId, message: text }));
  }

  document.querySelectorAll('.hb-qbtn').forEach(function(qbtn) {
    qbtn.addEventListener('click', function() {
      inp.value = qbtn.dataset.text;
      send();
    });
  });

  btn.addEventListener('click', function () { isOpen ? close() : open(); });
  closeBtn.addEventListener('click', close);
  sendBtn.addEventListener('click', send);
  inp.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  inp.addEventListener('input', function () {
    inp.style.height = 'auto';
    inp.style.height = Math.min(inp.scrollHeight, 90) + 'px';
  });

})();
