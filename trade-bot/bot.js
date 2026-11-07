// ==UserScript==
// @name         Deriv Trade Bot – Multi-Contract
// @namespace    https://github.com/JohnPeter64
// @version      4.1.0
// @description  DTrader helper: Rise/Fall, Higher/Lower, Touch, Ranges, Asians, Reset, Only ups/downs, High/Low tick, Multipliers, Accumulators (TP by ticks). Manual Buy buttons, entry strategies, payout & profit % on every contract, paper mode. Digit stats appear only when a Digits contract is chosen.
// @match        https://dtrader.deriv.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  if (window.__dtbLoaded) return;
  window.__dtbLoaded = true;

  // ---------- constants ----------
  const PUBLIC_WS = ['wss://api-core.deriv.com/options/v1/ws/public', 'wss://ws.derivws.com/websockets/v3?app_id=1089'];
  const TRADE_WS_BASE = 'wss://api-core.deriv.com/options/v1/ws';
  const WINDOWS = [20, 50, 100];
  const BUFFER = 1000;
  const SYMBOLS = {
    R_10: 'Volatility 10', R_25: 'Volatility 25', R_50: 'Volatility 50', R_75: 'Volatility 75', R_100: 'Volatility 100',
    '1HZ10V': 'Volatility 10 (1s)', '1HZ25V': 'Volatility 25 (1s)', '1HZ50V': 'Volatility 50 (1s)',
    '1HZ75V': 'Volatility 75 (1s)', '1HZ100V': 'Volatility 100 (1s)',
  };
  const CT_NAMES = {
    CALL: 'Rise', PUT: 'Fall', CALLE: 'Rise (allow equals)', PUTE: 'Fall (allow equals)', HIGHER: 'Higher', LOWER: 'Lower',
    ONETOUCH: 'Touch', NOTOUCH: 'No touch', DIGITMATCH: 'Matches', DIGITDIFF: 'Differs', DIGITEVEN: 'Even', DIGITODD: 'Odd',
    DIGITOVER: 'Over', DIGITUNDER: 'Under', ASIANU: 'Asian up', ASIAND: 'Asian down', RESETCALL: 'Reset call', RESETPUT: 'Reset put',
    RUNHIGH: 'Only ups', RUNLOW: 'Only downs', TICKHIGH: 'High tick', TICKLOW: 'Low tick', EXPIRYRANGE: 'Ends between',
    EXPIRYMISS: 'Ends outside', EXPIRYRANGEE: 'Ends between (allow equals)', EXPIRYMISSE: 'Ends outside (allow equals)',
    RANGE: 'Stays between', UPORDOWN: 'Goes outside', MULTUP: 'Multiplier up', MULTDOWN: 'Multiplier down', ACCU: 'Accumulator',
    TURBOSLONG: 'Turbos up', TURBOSSHORT: 'Turbos down', VANILLALONGCALL: 'Vanilla call', VANILLALONGPUT: 'Vanilla put',
  };
  const CAT_NAMES = {
    callput: 'Rise / Fall', callputequal: 'Rise / Fall (equals)', higherlower: 'Higher / Lower', touchnotouch: 'Touch / No touch',
    endsinout: 'Ends between / outside', staysinout: 'Stays between / goes outside', asian: 'Asians', reset: 'Reset call / put',
    runs: 'Only ups / downs', highlowticks: 'High / Low ticks', multiplier: 'Multipliers', accumulator: 'Accumulators',
    turbos: 'Turbos', vanilla: 'Vanillas', digits: 'Digits (shows digit stats)',
  };
  const CAT_ORDER = ['callput', 'callputequal', 'higherlower', 'touchnotouch', 'endsinout', 'staysinout', 'asian', 'reset', 'runs',
    'highlowticks', 'multiplier', 'accumulator', 'turbos', 'vanilla', 'digits'];
  const MARKET_NAMES = { synthetic_index: 'Derived', forex: 'Forex', indices: 'Stock indices', commodities: 'Commodities', cryptocurrency: 'Cryptocurrencies' };
  const PAIR0 = { CALL: 'PUT', CALLE: 'PUTE', HIGHER: 'LOWER', DIGITEVEN: 'DIGITODD', DIGITOVER: 'DIGITUNDER', DIGITMATCH: 'DIGITDIFF',
    MULTUP: 'MULTDOWN', RESETCALL: 'RESETPUT', RUNHIGH: 'RUNLOW', TICKHIGH: 'TICKLOW', ASIANU: 'ASIAND', TURBOSLONG: 'TURBOSSHORT',
    VANILLALONGCALL: 'VANILLALONGPUT', ONETOUCH: 'NOTOUCH', EXPIRYRANGE: 'EXPIRYMISS', EXPIRYRANGEE: 'EXPIRYMISSE', RANGE: 'UPORDOWN' };
  const PAIR = { ...PAIR0 };
  Object.entries(PAIR0).forEach(([a, b]) => { PAIR[b] = a; });
  const UPS = new Set(['CALL', 'CALLE', 'HIGHER', 'MULTUP', 'RESETCALL', 'RUNHIGH', 'ASIANU', 'TICKHIGH', 'TURBOSLONG', 'VANILLALONGCALL']);
  const DOWNS = new Set(['PUT', 'PUTE', 'LOWER', 'MULTDOWN', 'RESETPUT', 'RUNLOW', 'ASIAND', 'TICKLOW', 'TURBOSSHORT', 'VANILLALONGPUT']);
  const ONE_BAR = ['higherlower', 'touchnotouch', 'turbos', 'vanilla'], TWO_BAR = ['endsinout', 'staysinout'];
  // p: [label, default, min, step]
  const RULES = {
    manual: { name: 'Manual only (use the Buy buttons)', p: [], desc: 'The bot never enters by itself. Use the Buy buttons whenever you want to trade.' },
    always: { name: 'Every round (no filter)', p: [], desc: 'Enters again as soon as the pause between trades is over.' },
    trend: { name: 'Tick trend – N ups / downs in a row', p: [['N ticks', 3, 1, 1]],
      desc: 'After N rising ticks goes up, after N falling ticks goes down. "Reverse signal" bets on a pull-back instead.' },
    sma: { name: 'Moving average crossover', p: [['Fast MA', 5, 2, 1], ['Slow MA', 20, 3, 1]],
      desc: 'Goes up when the fast average crosses above the slow one, down when it crosses below.' },
    rsi: { name: 'RSI overbought / oversold', p: [['Period', 14, 2, 1], ['Oversold level', 30, 1, 1]],
      desc: 'Goes up when RSI is below the oversold level, down when above 100 minus that level (reversal idea).' },
    bb: { name: 'Bollinger Bands touch', p: [['Period', 20, 5, 1], ['Std devs', 2, 0.5, 0.1]],
      desc: 'Goes up when price closes below the lower band, down when above the upper band (reversal idea).' },
    momentum: { name: 'Momentum burst', p: [['Over N ticks', 5, 1, 1], ['× average move', 3, 0.5, 0.1]],
      desc: 'Follows a move over the last N ticks that is bigger than X times the average tick move.' },
    breakout: { name: 'Range breakout – new N-tick high / low', p: [['Lookback ticks', 20, 3, 1]],
      desc: 'Goes up when price breaks above the highest of the last N ticks, down when it breaks below the lowest.' },
    quiet: { name: 'Quiet market – calm last N ticks', p: [['Last ticks', 10, 3, 1], ['Max × avg move', 0.8, 0.1, 0.1]],
      desc: 'Enters only when recent tick moves are small compared with the last 100 ticks. Meant for Accumulators, Stays Between and Ends Between (no direction).' },
    digitpct: { name: 'Digit % – last 20/50/100 above threshold', p: [['Threshold %', 80, 50, 1]], digits: 1,
      desc: 'Enters when the chosen digit contract would have won more than the threshold in each of the last 20, 50 and 100 ticks.' },
    streak: { name: 'Digit streak – after N losing digits', p: [['N digits', 3, 1, 1]], digits: 1,
      desc: 'Enters after the last N digits would all have lost. "Reverse signal" = after N winning digits.' },
    parity: { name: 'Even / Odd streak', p: [['Streak N', 4, 1, 1]], digits: 1,
      desc: 'After N evens buys Odd, after N odds buys Even (use with Even/Odd).' },
    hot: { name: 'Most frequent digit (Matches / Differs)', p: [['Last ticks', 100, 10, 1]], digits: 1, desc: 'Sets the prediction to the most frequent digit in the last N ticks.' },
    cold: { name: 'Least frequent digit (Matches / Differs)', p: [['Last ticks', 100, 10, 1]], digits: 1, desc: 'Sets the prediction to the least frequent digit in the last N ticks.' },
    lastdigit: { name: 'Last digit equals…', p: [['Digit', 0, 0, 1]], digits: 1, desc: 'Enters on the tick right after the chosen digit appears.' },
  };
  const KEY_CFG = 'dtb_cfg_v1', KEY_UI = 'dtb_ui_v1', KEY_SESSION = { live: 'dtb_session_live_v1', paper: 'dtb_session_paper_v1' };
  const load = (k, d) => { try { return { ...d, ...JSON.parse(localStorage.getItem(k) || '{}') }; } catch (e) { return d; } };
  const cfg = load(KEY_CFG, {
    symbol: 'R_100', follow: true, mode: 'paper', stake: 1, takeProfit: 5, stopLoss: 5,
    cType: 'CALL', cDur: 5, cUnit: 't', cDigit: 5, cBar: '+0.20', cBar2: '-0.20', cTick: 1, cMult: 10, cGrowth: 0.01,
    cAccTicks: 10, cTP: 0, cSL: 0, rule: 'manual', rp: {}, rFlip: false, autoDir: true, maxTrades: 5, maxLossRow: 3, cooldown: 5,
    martingale: 1, maxSteps: 3, maxStake: 0, martManual: false,
    sound: true, toasts: true, popups: true, paperBal: 1000,
  });
  if (!RULES[cfg.rule]) cfg.rule = 'manual';
  const blankSession = () => ({ pl: 0, wins: 0, losses: 0, trades: 0, log: [], streak: 0, worstStreak: 0, peak: 0, maxDD: 0 });
  const sessions = { live: load(KEY_SESSION.live, blankSession()), paper: load(KEY_SESSION.paper, blankSession()) };
  const ui = load(KEY_UI, { left: '20px', top: '80px', width: '440px', height: '', collapsed: false, zoom: 1 });
  const saveCfg = () => localStorage.setItem(KEY_CFG, JSON.stringify(cfg));
  const saveSession = m => localStorage.setItem(KEY_SESSION[m], JSON.stringify(sessions[m]));
  const saveUi = () => localStorage.setItem(KEY_UI, JSON.stringify(ui));
  const sess = () => sessions[cfg.mode];

  const st = {
    pip: 2, digits: [], prices: [], quote: null, cool: 0, runTrades: 0, subId: null, hadSub: false,
    running: false, round: null, account: null, currency: 'USD', balance: null, tradeReady: false,
    symbols: null, contracts: [], barChoices: [], quotes: null, sig: null, step: 0,
  };
  const inRound = () => !!st.round;

  // ---------- styles ----------
  const style = document.createElement('style');
  style.textContent = `
  #dtb{position:fixed;z-index:2147483647;min-width:300px;min-height:44px;max-height:96vh;overflow:hidden;
    font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#eef2ff;border-radius:1.1em;
    background:linear-gradient(135deg,#1a1240,#0f2a4a,#0c3b3b,#2b1250);background-size:400% 400%;animation:dtbbg 18s ease infinite;
    border:1px solid rgba(255,255,255,.14);box-shadow:0 12px 40px rgba(0,0,0,.55),0 0 40px rgba(0,214,201,.15);
    display:flex;flex-direction:column;user-select:none}
  @keyframes dtbbg{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
  #dtb *{box-sizing:border-box}
  #dtb.collapsed{height:auto!important}#dtb.collapsed .dtb-body,#dtb.collapsed .dtb-grip{display:none}
  .dtb-grip{position:absolute;right:0;bottom:0;width:1.7em;height:1.7em;cursor:nwse-resize;touch-action:none;z-index:5;background:linear-gradient(135deg,transparent 0 48%,rgba(255,255,255,.6) 48% 55%,transparent 55% 66%,rgba(255,255,255,.6) 66% 73%,transparent 73% 84%,rgba(255,255,255,.6) 84% 91%,transparent 91%)}
  .dtb-head{display:flex;align-items:center;gap:.5em;padding:.55em .8em;cursor:move;background:linear-gradient(90deg,rgba(124,92,255,.55),rgba(0,214,201,.35));border-bottom:1px solid rgba(255,255,255,.12)}
  .dtb-title{font-weight:800;letter-spacing:.03em;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .dtb-hpl{font-weight:700;font-size:.95em;padding:.1em .5em;border-radius:.6em;background:rgba(0,0,0,.25)}
  .dtb-dot{width:.6em;height:.6em;border-radius:50%;background:#777}.dtb-dot.on{background:#18e08a;box-shadow:0 0 6px #18e08a}
  .dtb-ico{all:revert;background:rgba(0,0,0,.3);color:#fff;border:0;border-radius:.4em;width:1.8em;height:1.6em;padding:0;cursor:pointer}
  .dtb-body{flex:1;overflow:auto;padding:.7em .8em .9em}
  .dtb-card{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:.8em;padding:.6em .7em;margin-bottom:.6em}
  .dtb-card h4{margin:0 0 .45em;font-size:.78em;letter-spacing:.12em;text-transform:uppercase;color:#a9b4ff;font-weight:700}
  .dtb-row{display:flex;gap:.5em;align-items:center;flex-wrap:wrap}
  #dtb select,#dtb input[type=number],#dtb input[type=text]{all:revert;font:inherit;font-size:.9em;color:#fff;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.18);border-radius:.45em;padding:.25em .4em;width:100%;min-width:0}
  #dtb input[type=checkbox]{all:revert;appearance:auto;width:1em;height:1em;margin:0;accent-color:#00d6c9}
  #dtb label{display:flex;gap:.35em;align-items:center;cursor:pointer;font-size:.9em}
  .dtb-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:.45em}
  .dtb-grid2{display:grid;grid-template-columns:1fr 1.6fr;gap:.45em;margin-bottom:.5em}
  .dtb-grid div span,.dtb-grid2 div span{display:block;font-size:.72em;color:#a9b4ff;margin-bottom:.15em}
  .dtb-digits{position:relative;display:grid;grid-template-columns:repeat(10,1fr);gap:.3em;padding-bottom:1.1em}
  .dtb-d{display:flex;flex-direction:column;align-items:center}
  .dtb-c{width:2.3em;height:2.3em;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;background:rgba(0,0,0,.35);border:.18em solid rgba(255,255,255,.18)}
  .dtb-d.cur .dtb-c{background:linear-gradient(135deg,#7c5cff,#00d6c9);box-shadow:0 0 12px rgba(0,214,201,.8)}
  .dtb-p{margin-top:.2em;font-size:.72em;color:#c9d1ff}
  .dtb-cursor{position:absolute;bottom:0;width:0;height:0;border-left:.5em solid transparent;border-right:.5em solid transparent;border-bottom:.7em solid #ffd34d;transition:left .25s ease}
  .dtb-main{all:revert;font:inherit;font-weight:800;width:100%;margin-top:.55em;padding:.55em;border:0;border-radius:.6em;cursor:pointer;color:#062b22;background:linear-gradient(90deg,#18e08a,#00d6c9)}
  .dtb-main.stop{color:#fff;background:linear-gradient(90deg,#ff3d6e,#ff8a3d)}
  .dtb-buys{display:flex;gap:.6em;margin:.25em 0 .35em}
  .dtb-buy{all:revert;font:inherit;flex:1;display:flex;align-items:center;justify-content:center;gap:.6em;padding:.8em .6em;border:0;border-radius:.75em;cursor:pointer;color:#fff;text-align:left;
    box-shadow:0 .3em 0 rgba(0,0,0,.4),0 .55em 1.1em rgba(0,0,0,.35),inset 0 .1em 0 rgba(255,255,255,.35);transition:transform .08s,box-shadow .08s,filter .15s}
  .dtb-buy .ar{font-size:1.6em;line-height:1;text-shadow:0 1px 3px rgba(0,0,0,.45)}
  .dtb-buy .tx{display:flex;flex-direction:column;line-height:1.25}
  .dtb-buy b{font-size:1em;letter-spacing:.05em;text-shadow:0 1px 3px rgba(0,0,0,.4)}
  .dtb-buy small{font-size:.75em;opacity:.95}
  .dtb-buy.a{background:linear-gradient(180deg,#34e89e,#0d8f58)}
  .dtb-buy.b{background:linear-gradient(180deg,#ff6b8f,#c0143f)}
  .dtb-buy:hover{filter:brightness(1.12)}
  .dtb-buy:active{transform:translateY(.25em);box-shadow:0 .05em 0 rgba(0,0,0,.4),inset 0 .1em 0 rgba(255,255,255,.2)}
  .dtb-buy:disabled{opacity:.45;cursor:not-allowed;filter:grayscale(.5);transform:none}
  .dtb-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:.4em;text-align:center}
  .dtb-stats div{background:rgba(0,0,0,.25);border-radius:.5em;padding:.3em}.dtb-stats span{display:block;font-size:.7em;color:#a9b4ff}.dtb-stats b{font-size:1.05em}
  .dtb-big{font-size:1.5em!important}
  .pos{color:#18e08a}.neg{color:#ff5c8a}
  .dtb-small{all:revert;font:inherit;font-size:.78em;color:#fff;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.2);border-radius:.4em;padding:.2em .6em;cursor:pointer}
  .dtb-log{max-height:8em;overflow:auto;font-family:ui-monospace,Consolas,monospace;font-size:.75em;margin-top:.4em}
  .dtb-log div{display:flex;justify-content:space-between;gap:.5em;padding:.12em 0;border-bottom:1px dashed rgba(255,255,255,.08)}
  .dtb-status{font-size:.75em;color:#c9d1ff;margin-top:.4em;min-height:1.2em}
  .dtb-acc{font-size:.78em;color:#c9d1ff}
  .dtb-mode{font-size:.7em;font-weight:800;padding:.15em .5em;border-radius:.5em}
  .dtb-mode.paper{background:#ffd34d;color:#3a2a00}.dtb-mode.demo{background:#38bdf8;color:#04283b}.dtb-mode.real{background:#ff3d6e;color:#fff}
  .dtb-note{font-size:.75em;color:#ffd34d;margin-top:.3em}.dtb-desc{font-size:.74em;color:#c9d1ff;margin-top:.3em;line-height:1.35}
  .dtb-pl{font-size:.8em;line-height:1.5;padding:.35em .5em;margin-bottom:.35em;border-radius:.5em;background:rgba(0,0,0,.28)}
  .dtb-sigline{font-size:.85em;margin-top:.35em;padding:.3em .45em;border-radius:.45em;background:rgba(0,0,0,.25)}.dtb-sigline b.go{color:#18e08a}
  #dtb-toasts{position:fixed;top:16px;right:16px;z-index:2147483647;display:flex;flex-direction:column;gap:8px;pointer-events:none;font-family:system-ui,sans-serif}
  .dtb-toast{min-width:190px;padding:10px 16px;border-radius:12px;color:#fff;font-weight:800;font-size:15px;box-shadow:0 8px 24px rgba(0,0,0,.4);transition:opacity .4s,transform .4s}
  .dtb-toast small{display:block;font-weight:500;font-size:12px;opacity:.9}
  .dtb-toast.win{background:linear-gradient(135deg,#0f9d63,#18e08a)}.dtb-toast.loss{background:linear-gradient(135deg,#b3133e,#ff5c8a)}.dtb-toast.out{opacity:0;transform:translateX(30px)}
  #dtb-pop{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(5,8,20,.6);font-family:system-ui,sans-serif}
  .dtb-pc{width:min(400px,92vw);padding:26px;border-radius:22px;text-align:center;color:#fff}
  #dtb-pop.tp .dtb-pc{background:linear-gradient(160deg,#064e3b,#0f9d63 55%,#18e08a)}#dtb-pop.sl .dtb-pc{background:linear-gradient(160deg,#4c0519,#b3133e 55%,#ff5c8a)}
  #dtb-pop.stop .dtb-pc{background:linear-gradient(160deg,#3b2a05,#b7791f 55%,#f6ad55)}
  .dtb-pc .ttl{font-size:24px;font-weight:900}.dtb-pc .sub{font-size:13px;opacity:.9;margin-top:4px}.dtb-pc .amt{font-size:42px;font-weight:900;margin:12px 0 4px}
  .dtb-pc .mini{font-size:13px;opacity:.9;margin-top:10px}.dtb-pc .btns{display:flex;gap:10px;justify-content:center;margin-top:16px}
  .dtb-pc button{all:revert;font:inherit;font-weight:800;padding:9px 18px;border-radius:10px;border:0;cursor:pointer;background:rgba(255,255,255,.9);color:#111}
  `;
  document.head.appendChild(style);

  // ---------- markup ----------
  const panel = document.createElement('div');
  panel.id = 'dtb';
  Object.assign(panel.style, { left: ui.left, top: ui.top, width: ui.width });
  if (ui.height) panel.style.height = ui.height;
  if (ui.collapsed) panel.classList.add('collapsed');
  panel.innerHTML = `
    <div class="dtb-head"><span class="dtb-dot"></span><span class="dtb-title">Deriv Trade Bot</span>
      <span class="dtb-mode" data-v="mode"></span><span class="dtb-hpl">0.00</span><button class="dtb-ico" data-a="zoom-out" title="Smaller text">A−</button><button class="dtb-ico" data-a="zoom-in" title="Bigger text">A+</button><button class="dtb-ico" data-a="collapse">▾</button></div>
    <div class="dtb-body">
      <div class="dtb-card">
        <div class="dtb-row" style="flex-wrap:nowrap"><select data-f="symbol">${Object.entries(SYMBOLS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
          <label style="white-space:nowrap"><input type="checkbox" data-f="follow"> follow DTrader</label></div>
        <div class="dtb-grid2" style="margin-top:.5em;margin-bottom:0">
          <div><span>Mode</span><select data-f="mode"><option value="paper">Paper (simulated)</option><option value="live">Account (use DEMO!)</option></select></div>
          <div class="dtb-acc" style="align-self:end">Account: <b data-v="acc">checking…</b><br>Balance: <b data-v="bal">-</b></div></div>
      </div>
      <div class="dtb-card">
        <h4>Contract</h4>
        <div class="dtb-grid2">
          <div><span>Trade type</span><select data-f="cType"><option>loading…</option></select></div>
          <div data-c="dur"><span>Duration</span><div style="display:flex;gap:.3em"><input type="number" min="1" step="1" data-f="cDur" style="width:40%"><select data-f="cUnit" style="width:60%"></select></div></div>
        </div>
        <div class="dtb-grid">
          <div><span>Stake</span><input type="number" step="0.01" min="0.35" data-f="stake"></div>
          <div data-c="digit"><span>Prediction</span><select data-f="cDigit"></select></div>
          <div data-c="bar"><span data-v="barLbl">Barrier</span><input type="text" data-f="cBar" list="dtb-bars"></div>
          <div data-c="bar2"><span>Low barrier</span><input type="text" data-f="cBar2"></div>
          <div data-c="tick"><span>Tick no.</span><select data-f="cTick">${[1, 2, 3, 4, 5].map(i => `<option>${i}</option>`).join('')}</select></div>
          <div data-c="mult"><span>Multiplier</span><select data-f="cMult"></select></div>
          <div data-c="growth"><span>Growth / tick</span><select data-f="cGrowth"></select></div>
          <div data-c="acc"><span>TP after N ticks</span><input type="number" step="1" min="0" data-f="cAccTicks" title="Take profit is set so it triggers after N ticks in range. 0 = use Contract TP"></div>
          <div data-c="ctp"><span>Contract TP</span><input type="number" step="0.01" min="0" data-f="cTP"></div>
          <div data-c="csl"><span>Contract SL</span><input type="number" step="0.01" min="0" data-f="cSL"></div>
        </div>
        <datalist id="dtb-bars"></datalist>
        <div class="dtb-note" data-v="cnote"></div>
      </div>
      <div class="dtb-card">
        <h4>Payout &amp; profit %</h4>
        <div data-v="pay">pricing…</div>
        <div class="dtb-buys"><button class="dtb-buy a" data-a="buy-main">BUY</button><button class="dtb-buy b" data-a="buy-alt">BUY</button></div>
        <div class="dtb-note" data-v="buynote">Buy buttons trade immediately, any time you press them.</div>
      </div>
      <div class="dtb-card" data-card="digits">
        <h4>Last digit (${BUFFER} ticks)</h4>
        <div class="dtb-digits">${[...Array(10).keys()].map(d => `<div class="dtb-d" data-d="${d}"><div class="dtb-c">${d}</div><div class="dtb-p">-</div></div>`).join('')}<div class="dtb-cursor"></div></div>
        <div class="dtb-row" style="justify-content:space-between;font-size:.85em"><span>Price <b data-v="price">-</b></span><span>Last <b data-v="last">-</b></span></div>
      </div>
      <div class="dtb-card">
        <h4>Auto strategy &amp; risk</h4>
        <select data-f="rule"></select>
        <div class="dtb-grid" style="margin-top:.45em">
          <div data-r="0"><span data-v="rl0">-</span><input type="number" step="any" data-f="rp0"></div>
          <div data-r="1"><span data-v="rl1">-</span><input type="number" step="any" data-f="rp1"></div>
          <div style="grid-column:span 2;display:flex;flex-direction:column;gap:.25em;justify-content:flex-end">
            <label><input type="checkbox" data-f="autoDir"> Rule picks direction</label><label><input type="checkbox" data-f="rFlip"> Reverse signal</label></div>
        </div>
        <div class="dtb-sigline">Signal: <b data-v="sig">-</b></div>
        <div class="dtb-desc" data-v="rdesc"></div><div class="dtb-note" data-v="rnote"></div>
        <div class="dtb-grid" style="margin-top:.5em">
          <div><span>Take profit</span><input type="number" step="0.01" min="0" data-f="takeProfit"></div>
          <div><span>Stop loss</span><input type="number" step="0.01" min="0" data-f="stopLoss"></div>
          <div><span>Max trades</span><input type="number" step="1" min="0" data-f="maxTrades" title="per START, 0 = unlimited"></div>
          <div><span>Stop after losses</span><input type="number" step="1" min="0" data-f="maxLossRow" title="in a row, 0 = off"></div>
          <div><span>Martingale ×</span><input type="number" step="0.1" min="1" data-f="martingale" title="Stake multiplier after a loss. 1 = flat stake"></div>
          <div><span>Max steps</span><input type="number" step="1" min="0" data-f="maxSteps" title="After this many increases the stake returns to base. 0 = unlimited"></div>
          <div><span>Max stake</span><input type="number" step="0.01" min="0" data-f="maxStake" title="Above this the stake returns to base. 0 = no cap"></div>
          <div style="align-self:end"><label title="Also apply martingale to the Buy buttons"><input type="checkbox" data-f="martManual"> on Buy too</label></div>
          <div style="grid-column:span 2"><span>Pause between trades (ticks)</span><input type="number" step="1" min="0" data-f="cooldown"></div>
          <div style="grid-column:span 2;align-self:end;font-size:.85em">Next stake: <b data-v="next">-</b> · step <b data-v="step">0</b></div>
        </div>
        <button class="dtb-main" data-a="toggle">START AUTO BOT</button>
        <div class="dtb-status" data-v="status"></div>
        <div class="dtb-note">Random markets (synthetic indices) can't be predicted: no strategy beats the payout margin. Practise on Paper or Demo. Martingale only changes stake size, not the odds: a run of losses grows fast.</div>
      </div>
      <div class="dtb-card"><h4>Alerts</h4>
        <div class="dtb-row" style="justify-content:space-between"><label><input type="checkbox" data-f="sound"> Sounds</label><label><input type="checkbox" data-f="toasts"> Win/loss pop-ups</label><label><input type="checkbox" data-f="popups"> TP/SL pop-up</label></div>
        <div class="dtb-row" style="margin-top:.45em;flex-wrap:nowrap"><span style="font-size:.8em;white-space:nowrap">Paper balance</span><input type="number" step="1" min="0" data-f="paperBal" style="width:6em"><button class="dtb-small" data-a="release" title="Forget an open round that never settled">Release round</button></div>
      </div>
      <div class="dtb-card">
        <div class="dtb-row" style="justify-content:space-between"><h4 style="margin:0" data-v="sessTitle">Session</h4><button class="dtb-small" data-a="reset">Reset P/L</button></div>
        <div class="dtb-stats" style="margin-top:.45em">
          <div style="grid-column:span 2"><span>Profit / Loss</span><b class="dtb-big" data-v="pl">0.00</b></div>
          <div style="grid-column:span 2"><span data-v="balLbl">Balance</span><b class="dtb-big" data-v="balance">-</b></div>
          <div><span>Trades</span><b data-v="trades">0</b></div><div><span>Wins</span><b data-v="wins" class="pos">0</b></div>
          <div><span>Losses</span><b data-v="losses" class="neg">0</b></div><div><span>Win %</span><b data-v="wr">-</b></div>
          <div style="grid-column:span 2"><span>Worst losing streak</span><b data-v="worst" class="neg">0</b></div>
          <div style="grid-column:span 2"><span>Biggest drop</span><b data-v="dd" class="neg">0.00</b></div>
        </div>
        <div class="dtb-log" data-v="log"></div>
      </div>
    </div>
    <div class="dtb-grip" title="Drag to resize"></div>`;
  document.body.appendChild(panel);

  const q = s => panel.querySelector(s);
  const V = k => q(`[data-v="${k}"]`);
  const F = k => q(`[data-f="${k}"]`);
  const digitEls = [...panel.querySelectorAll('.dtb-d')];
  const fmt = n => (Math.round(n * 100) / 100).toFixed(2);
  const r2 = n => Math.round(n * 100) / 100;
  const setStatus = t => { V('status').textContent = t; };
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const setVal = (el, v) => { if (document.activeElement !== el) el.value = v; };
  const setOpts = (el, html) => { if (el.dataset.h !== html) { el.innerHTML = html; el.dataset.h = html; } };

  // ---------- settings binding ----------
  ['symbol', 'mode', 'stake', 'takeProfit', 'stopLoss', 'cDur', 'cDigit', 'cBar', 'cBar2', 'cTick', 'cAccTicks', 'cTP', 'cSL', 'maxTrades', 'maxLossRow', 'cooldown', 'paperBal', 'martingale', 'maxSteps', 'maxStake']
    .forEach(k => { F(k).value = cfg[k]; });
  ['follow', 'autoDir', 'rFlip', 'sound', 'toasts', 'popups', 'martManual'].forEach(k => { F(k).checked = !!cfg[k]; });
  const STR = ['mode', 'cType', 'cUnit', 'cBar', 'cBar2', 'rule'];
  panel.addEventListener('change', e => {
    const k = e.target.dataset.f;
    if (!k) return;
    if (k === 'rp0' || k === 'rp1') {
      const i = +k[2], def = RULES[cfg.rule].p[i], v = parseFloat(e.target.value);
      cfg.rp[cfg.rule] = cfg.rp[cfg.rule] || [];
      cfg.rp[cfg.rule][i] = isNaN(v) ? def[1] : Math.max(def[2], v);
      saveCfg(); return renderRule();
    }
    if (k === 'mode' && (st.running || inRound())) { e.target.value = cfg.mode; return setStatus('Stop the bot and wait for the open trade to finish before changing mode.'); }
    if ((k === 'symbol' || k === 'follow') && inRound()) {
      if (k === 'symbol') e.target.value = cfg.symbol; else e.target.checked = cfg.follow;
      return setStatus('Wait for the open trade to finish before changing market.');
    }
    if (e.target.type === 'checkbox') cfg[k] = e.target.checked;
    else if (k === 'symbol') { cfg.symbol = e.target.value; cfg.follow = false; F('follow').checked = false; }
    else if (STR.includes(k)) cfg[k] = e.target.value.trim();
    else cfg[k] = Math.max(0, parseFloat(e.target.value) || 0);
    if (k === 'martingale') cfg.martingale = Math.max(1, cfg.martingale || 1);
    if (k === 'cType') applyTypeDefaults();
    if (k === 'cUnit') {
      const en = entryFor();
      st.barChoices = [];
      if (en) { cfg.cDur = durUnit(en.min_contract_duration) === cfg.cUnit ? durNum(en.min_contract_duration) : 1; applyBarrierDefaults(en); }
    }
    saveCfg();
    if (k === 'symbol') subscribeTicks();
    if (k === 'follow') checkDtraderSymbol();
    if (['stake', 'martingale', 'maxSteps', 'maxStake', 'mode', 'martManual'].includes(k) && !inRound()) st.step = 0;
    if (k[0] === 'c' || k === 'stake') requestQuotes();
    renderAll();
  });
  panel.addEventListener('mousedown', e => e.stopPropagation());

  q('[data-a="collapse"]').onclick = () => {
    panel.classList.toggle('collapsed');
    ui.collapsed = panel.classList.contains('collapsed');
    q('[data-a="collapse"]').textContent = ui.collapsed ? '▸' : '▾';
    saveUi();
  };
  q('[data-a="collapse"]').textContent = ui.collapsed ? '▸' : '▾';
  (() => {
    const head = q('.dtb-head');
    let sx, sy, ox, oy, drag = false;
    head.addEventListener('mousedown', e => {
      if (e.target.tagName === 'BUTTON') return;
      drag = true; sx = e.clientX; sy = e.clientY; ox = panel.offsetLeft; oy = panel.offsetTop; e.preventDefault();
    });
    window.addEventListener('mousemove', e => {
      if (!drag) return;
      panel.style.left = Math.max(0, ox + e.clientX - sx) + 'px';
      panel.style.top = Math.max(0, oy + e.clientY - sy) + 'px';
    });
    window.addEventListener('mouseup', () => { if (drag) { drag = false; ui.left = panel.style.left; ui.top = panel.style.top; saveUi(); } });
  })();
  const applyScale = () => { panel.style.fontSize = Math.max(8, Math.min(32, panel.offsetWidth / 31 * (ui.zoom || 1))) + 'px'; };
  new ResizeObserver(() => {
    applyScale();
    if (!panel.classList.contains('collapsed')) { ui.width = panel.style.width || panel.offsetWidth + 'px'; ui.height = panel.style.height || ''; }
    renderCursor();
    clearTimeout(applyScale.t); applyScale.t = setTimeout(saveUi, 300);
  }).observe(panel);
  applyScale();

  (() => {
    const grip = q('.dtb-grip');
    let sx, sy, sw, sh, on = false;
    grip.addEventListener('pointerdown', e => { on = true; sx = e.clientX; sy = e.clientY; sw = panel.offsetWidth; sh = panel.offsetHeight; grip.setPointerCapture(e.pointerId); e.preventDefault(); });
    grip.addEventListener('pointermove', e => {
      if (!on) return;
      panel.style.width = Math.max(300, sw + e.clientX - sx) + 'px';
      panel.style.height = Math.max(140, sh + e.clientY - sy) + 'px';
    });
    const end = () => { if (on) { on = false; saveUi(); } };
    grip.addEventListener('pointerup', end); grip.addEventListener('pointercancel', end);
    const zoom = d => { ui.zoom = Math.round(Math.max(.7, Math.min(1.8, (ui.zoom || 1) + d)) * 10) / 10; applyScale(); saveUi(); };
    q('[data-a="zoom-in"]').onclick = () => zoom(.1);
    q('[data-a="zoom-out"]').onclick = () => zoom(-.1);
  })();

  // ---------- helpers for contract metadata ----------
  const lastDigit = (quote, pip) => +Number(quote).toFixed(pip).slice(-1);
  const UNITS = { tick: ['t'], intraday: ['s', 'm', 'h'], daily: ['d'] };
  const UNIT_NAMES = { t: 'ticks', s: 'seconds', m: 'minutes', h: 'hours', d: 'days' };
  const entriesFor = ct => st.contracts.filter(e => e.contract_type === ct);
  const expiryOf = u => u === 't' ? 'tick' : u === 'd' ? 'daily' : 'intraday';
  const entryFor = (ct = cfg.cType) => { const es = entriesFor(ct); return es.find(e => e.expiry_type === expiryOf(cfg.cUnit)) || es[0] || null; };
  const noExpiry = e => e && e.expiry_type === 'no_expiry';
  const durNum = s => parseInt(s, 10) || 1;
  const durUnit = s => (String(s).match(/[a-z]+$/) || ['t'])[0];
  const catOf = () => entryFor()?.contract_category;
  const digitCat = () => catOf() === 'digits';
  const stakeNow = () => Math.max(+cfg.stake, 0.35);
  const stakeAt = step => r2(stakeNow() * Math.pow(Math.max(1, +cfg.martingale || 1), step));
  const nextStake = () => stakeAt(st.step);
  const accTPFor = stake => r2(stake * (Math.pow(1 + +cfg.cGrowth, Math.round(cfg.cAccTicks)) - 1));
  const symName = sym => st.symbols?.find(x => x.underlying_symbol === sym)?.underlying_symbol_name || SYMBOLS[sym] || sym;
  const ctLabel = p => p ? (CT_NAMES[p.contract_type] || p.contract_type) + (/^DIGIT(MATCH|DIFF|OVER|UNDER)$/.test(p.contract_type) ? ' ' + p.barrier : '') : '-';

  function applyBarrierDefaults(e) {
    if (e.contract_category === 'turbos') {
      const sign = e.contract_type === 'TURBOSLONG' ? '-' : '+', ch = (e.barrier_choices || []).map(b => sign + String(b).replace(/^[+-]/, ''));
      st.barChoices = ch; cfg.cBar = ch[Math.floor(ch.length / 2)] || cfg.cBar;
    } else if (e.contract_category === 'vanilla') { st.barChoices = e.barrier_choices || []; cfg.cBar = e.barrier ?? cfg.cBar; }
    else if (e.barriers === 2) { cfg.cBar = e.high_barrier ?? cfg.cBar; cfg.cBar2 = e.low_barrier ?? cfg.cBar2; }
    else if (e.barrier !== undefined) cfg.cBar = e.barrier;
  }
  function applyTypeDefaults() {
    const es = entriesFor(cfg.cType);
    if (!es.length) return;
    const e = es.find(x => x.expiry_type === 'tick') || es.find(x => x.expiry_type === 'intraday') || es[0];
    if (!noExpiry(e)) {
      cfg.cUnit = durUnit(e.min_contract_duration); cfg.cDur = durNum(e.min_contract_duration);
      if (cfg.cUnit === 't' && durUnit(e.max_contract_duration) === 't') cfg.cDur = Math.min(Math.max(cfg.cDur, 5), durNum(e.max_contract_duration));
    }
    st.barChoices = [];
    applyBarrierDefaults(e);
    const ld = e.last_digit_range;
    if (ld && !ld.includes(+cfg.cDigit)) cfg.cDigit = ld[Math.floor(ld.length / 2)];
    if (e.multiplier_range && !e.multiplier_range.includes(+cfg.cMult)) cfg.cMult = e.multiplier_range[0];
    if (e.growth_rate_range && !e.growth_rate_range.includes(+cfg.cGrowth)) cfg.cGrowth = e.growth_rate_range[0];
  }
  function onContracts(list) {
    st.contracts = list;
    if (!entriesFor(cfg.cType).length && list.length) {
      cfg.cType = list.some(e => e.contract_type === 'CALL') ? 'CALL' : list[0].contract_type;
      applyTypeDefaults(); saveCfg();
    } else if (!entryFor() || entryFor().expiry_type !== expiryOf(cfg.cUnit)) { applyTypeDefaults(); saveCfg(); }
    renderAll();
    requestQuotes();
  }

  function customParams(stake) {
    const e = entryFor(), cat = e?.contract_category;
    const p = { contract_type: cfg.cType, amount: stake, basis: 'stake', underlying_symbol: cfg.symbol };
    if (e && !noExpiry(e)) { p.duration = Math.max(1, Math.round(cfg.cDur)); p.duration_unit = cfg.cUnit; }
    if (cat === 'digits' && e.barriers === 1) p.barrier = String(cfg.cDigit);
    if (ONE_BAR.includes(cat) || TWO_BAR.includes(cat)) p.barrier = String(cfg.cBar).trim();
    if (TWO_BAR.includes(cat)) p.barrier2 = String(cfg.cBar2).trim();
    if (cat === 'highlowticks') p.selected_tick = Math.round(cfg.cTick);
    if (cat === 'multiplier') {
      p.multiplier = +cfg.cMult;
      const lo = {};
      if (cfg.cTP > 0) lo.take_profit = +cfg.cTP;
      if (cfg.cSL > 0) lo.stop_loss = +cfg.cSL;
      if (Object.keys(lo).length) p.limit_order = lo;
    }
    if (cat === 'accumulator') {
      p.growth_rate = +cfg.cGrowth;
      const tp = cfg.cAccTicks > 0 ? accTPFor(stake) : +cfg.cTP;
      if (tp > 0) p.limit_order = { take_profit: tp };
    }
    return p;
  }
  // opposite contract (Rise↔Fall, Touch↔No touch …); null when the market doesn't offer it
  function flipParams(p) {
    const ct2 = PAIR[p.contract_type];
    if (!ct2 || !entriesFor(ct2).length) return null;
    const q2 = { ...p, contract_type: ct2 };
    if (ct2 === 'DIGITOVER' || ct2 === 'DIGITUNDER') q2.barrier = String(9 - +p.barrier);
    else if (/^(HIGHER|LOWER|TURBOS)/.test(ct2) && /^[+-]/.test(String(p.barrier))) q2.barrier = (p.barrier[0] === '+' ? '-' : '+') + p.barrier.slice(1);
    return q2;
  }

  // ---------- payout & profit % ----------
  let propGen = 0;
  const stakeLabel = () => fmt(stakeNow());
  function requestQuotes() {
    if (!entryFor()) return;
    const gen = ++propGen, p0 = customParams(stakeNow()), alt = flipParams(p0);
    st.quotes = { gen, main: { label: ctLabel(p0) }, alt: alt ? { label: ctLabel(alt) } : null };
    pubSend({ proposal: 1, currency: 'USD', ...p0, passthrough: { pp: 'main', gen } });
    if (alt) pubSend({ proposal: 1, currency: 'USD', ...alt, passthrough: { pp: 'alt', gen } });
    renderPayout();
  }
  setInterval(requestQuotes, 10000);
  function onQuote(m) {
    const pt = m.echo_req.passthrough || {};
    if (!st.quotes || pt.gen !== st.quotes.gen) return;
    const slot = st.quotes[pt.pp];
    if (!slot) return;
    if (m.error) {
      const ch = m.error.details?.barrier_choices;
      if (pt.pp === 'main' && ch && ch.length) {
        st.barChoices = ch;
        if (!ch.includes(String(cfg.cBar))) { cfg.cBar = ch[Math.floor(ch.length / 2)]; saveCfg(); renderContract(); return requestQuotes(); }
      }
      slot.err = m.error.message;
    } else {
      const pr = m.proposal;
      slot.ask = +pr.ask_price; slot.payout = +pr.payout || 0; slot.commission = +pr.commission || 0;
      slot.ratio = slot.payout > 0 && slot.ask > 0 ? slot.payout / slot.ask : null; slot.err = null;
    }
    renderPayout();
  }
  function sideHtml(qt) {
    if (!qt) return '';
    if (qt.err) return `<div class="dtb-pl"><b>${qt.label}</b> <span class="neg">${qt.err}</span></div>`;
    if (qt.ask === undefined) return `<div class="dtb-pl"><b>${qt.label}</b> pricing…</div>`;
    const cat = catOf();
    if (qt.payout > 0) {
      const profit = qt.payout - qt.ask;
      return `<div class="dtb-pl"><b>${qt.label}</b><br>Payout <b>${fmt(qt.payout)}</b> · Profit <b class="pos">+${fmt(profit)} (+${(profit / qt.ask * 100).toFixed(1)}%)</b> · Loss <b class="neg">−${fmt(qt.ask)} (−100%)</b><br>Break-even win rate <b>${(qt.ask / qt.payout * 100).toFixed(1)}%</b></div>`;
    }
    if (cat === 'multiplier') {
      const m = +cfg.cMult, per = qt.ask * m * 0.01;
      return `<div class="dtb-pl"><b>${qt.label}</b> x${m}<br>Stake ${fmt(qt.ask)} · commission ${fmt(qt.commission)}<br>Each 1% price move = <b>±${fmt(per)} (±${m}%)</b> of stake · stop-out at a ${(100 / m).toFixed(2)}% move against you (−100%)${cfg.cTP > 0 ? `<br>TP <b class="pos">+${fmt(cfg.cTP)} (+${(cfg.cTP / qt.ask * 100).toFixed(0)}%)</b>` : ''}${cfg.cSL > 0 ? ` · SL <b class="neg">−${fmt(cfg.cSL)} (−${(cfg.cSL / qt.ask * 100).toFixed(0)}%)</b>` : ''}</div>`;
    }
    if (cat === 'accumulator') {
      const g = +cfg.cGrowth, n = Math.round(cfg.cAccTicks), tp = n > 0 ? accTPFor(qt.ask) : +cfg.cTP;
      return `<div class="dtb-pl"><b>${qt.label}</b> · stake grows <b>${+(g * 100).toFixed(2)}%</b> per tick in range<br>${tp > 0
        ? `Take profit${n > 0 ? ` after ${n} ticks` : ''}: payout <b>${fmt(qt.ask + tp)}</b> · profit <b class="pos">+${fmt(tp)} (+${(tp / qt.ask * 100).toFixed(1)}%)</b>`
        : 'No take profit set'}<br>Knock-out (price leaves the barrier): loss <b class="neg">−${fmt(qt.ask)} (−100%)</b></div>`;
    }
    return `<div class="dtb-pl"><b>${qt.label}</b> · cost ${fmt(qt.ask)}${qt.commission ? ' · commission ' + fmt(qt.commission) : ''} (no fixed payout)</div>`;
  }
  const pctOf = qt => qt && qt.ratio ? ` (+${((qt.ratio - 1) * 100).toFixed(0)}%)` : '';
  function renderPayout() {
    const qs = st.quotes;
    V('pay').innerHTML = qs ? sideHtml(qs.main) + sideHtml(qs.alt) : 'pricing…';
    const bm = q('[data-a="buy-main"]'), ba = q('[data-a="buy-alt"]');
    const colour = (ct, def) => UPS.has(ct) ? 'a' : DOWNS.has(ct) ? 'b' : def;
    const inner = (qt, ct) => {
      const arrow = UPS.has(ct) ? '▲' : DOWNS.has(ct) ? '▼' : '●', cat = catOf();
      const sub = !qt || qt.ask === undefined ? 'pricing…' : qt.err ? 'unavailable'
        : qt.payout > 0 ? `Payout ${fmt(qt.payout)} · +${((qt.payout / qt.ask - 1) * 100).toFixed(0)}%`
        : cat === 'multiplier' ? `x${cfg.cMult} · stake ${fmt(qt.ask)}`
        : cat === 'accumulator' ? `${+(cfg.cGrowth * 100).toFixed(2)}% per tick · stake ${fmt(qt.ask)}` : `cost ${fmt(qt.ask)}`;
      return `<span class="ar">${arrow}</span><span class="tx"><b>BUY ${qt ? qt.label.toUpperCase() : ''}</b><small>${sub}</small></span>`;
    };
    bm.className = 'dtb-buy ' + colour(cfg.cType, 'a');
    bm.innerHTML = qs ? inner(qs.main, cfg.cType) : 'BUY';
    ba.style.display = qs && qs.alt ? '' : 'none';
    if (qs && qs.alt) { ba.className = 'dtb-buy ' + colour(PAIR[cfg.cType], 'b'); ba.innerHTML = inner(qs.alt, PAIR[cfg.cType]); }
    bm.disabled = ba.disabled = inRound();
    V('buynote').textContent = `Buy buttons trade immediately · stake ${fmt(cfg.martManual ? nextStake() : stakeNow())}${inRound() ? ' · a trade is open' : ''}`;
  }

  // ---------- public data stream ----------
  let pubWs, pubIdx = 0, pubPing, subGen = 0, forgetResolve = null;
  const pubSend = o => pubWs && pubWs.readyState === 1 && pubWs.send(JSON.stringify(o));
  function subscribeTicks() {
    const gen = ++subGen;
    st.digits = []; st.prices = []; st.subId = null; st.contracts = []; st.quotes = null;
    if (![...F('symbol').options].some(o => o.value === cfg.symbol)) F('symbol').add(new Option(cfg.symbol, cfg.symbol));
    F('symbol').value = cfg.symbol;
    renderAll();
    const start = () => {
      if (gen !== subGen) return;
      pubSend({ ticks_history: cfg.symbol, count: BUFFER, end: 'latest', style: 'ticks', subscribe: 1 });
      pubSend({ contracts_for: cfg.symbol });
    };
    if (!st.hadSub) return start();
    new Promise(res => { forgetResolve = res; pubSend({ forget_all: 'ticks' }); setTimeout(res, 3000); }).then(start);
  }
  function connectPublic() {
    clearInterval(pubPing);
    let opened = false;
    pubWs = new WebSocket(PUBLIC_WS[pubIdx]);
    pubWs.onopen = () => { opened = true; st.hadSub = false; subscribeTicks(); pubSend({ active_symbols: 'brief' }); pubPing = setInterval(() => pubSend({ ping: 1 }), 30000); };
    pubWs.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.msg_type === 'forget_all') { st.hadSub = false; if (forgetResolve) { forgetResolve(); forgetResolve = null; } return; }
      if (m.msg_type === 'active_symbols' && m.active_symbols) { st.symbols = m.active_symbols; renderSymbols(); return; }
      if (m.msg_type === 'contracts_for') {
        if (m.echo_req.contracts_for !== cfg.symbol) return;
        if (m.error) { st.contracts = []; V('cnote').textContent = 'Deriv: ' + m.error.message; return; }
        onContracts(m.contracts_for.available || []);
        return;
      }
      if (m.msg_type === 'proposal') return onQuote(m);
      if (m.error) { if (m.msg_type !== 'ping') setStatus('Market data: ' + m.error.message); return; }
      if (m.msg_type === 'history' && m.echo_req.ticks_history === cfg.symbol) {
        st.hadSub = true;
        st.subId = m.subscription && m.subscription.id;
        st.pip = m.pip_size ?? st.pip;
        st.digits = m.history.prices.map(p => lastDigit(p, st.pip));
        st.prices = m.history.prices.map(Number);
        st.quote = m.history.prices[m.history.prices.length - 1];
        onTick(false);
      } else if (m.msg_type === 'tick' && m.tick.symbol === cfg.symbol && (!st.subId || m.subscription?.id === st.subId)) {
        st.pip = m.tick.pip_size ?? st.pip;
        st.quote = m.tick.quote;
        st.digits.push(lastDigit(m.tick.quote, st.pip));
        st.prices.push(+m.tick.quote);
        if (st.digits.length > BUFFER) st.digits.splice(0, st.digits.length - BUFFER);
        if (st.prices.length > BUFFER) st.prices.splice(0, st.prices.length - BUFFER);
        onTick(true);
      }
    };
    pubWs.onclose = () => { clearInterval(pubPing); if (!opened) pubIdx = (pubIdx + 1) % PUBLIC_WS.length; setTimeout(connectPublic, 3000); };
  }
  function renderSymbols() {
    const sel = F('symbol'), order = Object.keys(MARKET_NAMES), groups = {};
    st.symbols.forEach(x => (groups[x.market] = groups[x.market] || []).push(x));
    const html = Object.keys(groups).sort((a, b) => (order.indexOf(a) + 99) % 99 - (order.indexOf(b) + 99) % 99)
      .map(g => `<optgroup label="${MARKET_NAMES[g] || g}">${groups[g].sort((a, b) => a.underlying_symbol_name.localeCompare(b.underlying_symbol_name))
        .map(x => `<option value="${x.underlying_symbol}">${x.underlying_symbol_name}${x.exchange_is_open ? '' : ' (closed)'}</option>`).join('')}</optgroup>`).join('');
    setOpts(sel, html);
    if (![...sel.options].some(o => o.value === cfg.symbol)) sel.add(new Option(cfg.symbol, cfg.symbol));
    sel.value = cfg.symbol;
  }
  function checkDtraderSymbol() {
    if (!cfg.follow || inRound()) return;
    const s = new URLSearchParams(location.search).get('symbol');
    if (s && s !== cfg.symbol) { cfg.symbol = s; saveCfg(); subscribeTicks(); }
  }
  setInterval(checkDtraderSymbol, 1500);

  function onTick(isLive) {
    renderDigits();
    renderRule();
    if (!isLive) return;
    paperCheck();
    maybeTrade();
  }

  // ---------- rendering ----------
  function renderCursor() {
    const cur = st.digits[st.digits.length - 1];
    if (cur === undefined || !digitCat()) return;
    const t = digitEls[cur], c = q('.dtb-cursor');
    c.style.left = (t.offsetLeft + t.offsetWidth / 2 - c.offsetWidth / 2) + 'px';
  }
  function renderDigits() {
    if (!digitCat()) return;
    const arr = st.digits.slice(-BUFFER), n = arr.length;
    if (!n) return;
    const counts = Array(10).fill(0);
    arr.forEach(d => counts[d]++);
    const cur = st.digits[st.digits.length - 1];
    digitEls.forEach((el, d) => { el.querySelector('.dtb-p').textContent = (counts[d] / n * 100).toFixed(0) + '%'; el.classList.toggle('cur', d === cur); });
    renderCursor();
    V('price').textContent = Number(st.quote).toFixed(st.pip);
    V('last').textContent = cur;
  }
  function balanceText(mode) {
    if (mode === 'paper') return fmt(+cfg.paperBal + sessions.paper.pl) + ' USD';
    return st.balance != null ? `${fmt(st.balance)} ${st.currency}` : '-';
  }
  function renderSession() {
    const s = sess();
    [V('pl'), q('.dtb-hpl')].forEach(el => {
      el.textContent = (s.pl > 0 ? '+' : '') + fmt(s.pl);
      el.classList.toggle('pos', s.pl > 0); el.classList.toggle('neg', s.pl < 0);
    });
    const at = accountType(st.account);
    V('mode').textContent = cfg.mode === 'paper' ? 'PAPER' : at === 'real' ? 'LIVE-REAL' : 'LIVE-DEMO';
    V('mode').className = 'dtb-mode ' + (cfg.mode === 'paper' ? 'paper' : at === 'real' ? 'real' : 'demo');
    V('sessTitle').textContent = `Session (${cfg.mode})`;
    V('trades').textContent = s.trades; V('wins').textContent = s.wins; V('losses').textContent = s.losses;
    V('wr').textContent = s.trades ? (s.wins / s.trades * 100).toFixed(0) + '%' : '-';
    V('balLbl').textContent = cfg.mode === 'paper' ? 'Paper balance' : 'Balance';
    V('balance').textContent = balanceText(cfg.mode);
    V('worst').textContent = s.worstStreak || 0;
    V('dd').textContent = '-' + fmt(s.maxDD || 0);
    V('next').textContent = fmt(nextStake()); V('step').textContent = st.step;
    setVal(F('martingale'), cfg.martingale);
    V('log').innerHTML = s.log.slice(0, 30).map(l =>
      `<div><span>${l.t} ${l.type}${l.digit !== undefined ? ' d=' + l.digit : ''}</span><span>${fmt(l.stake)}${l.pct != null ? ' @+' + l.pct.toFixed(0) + '%' : ''} → <b class="${l.profit >= 0 ? 'pos' : 'neg'}">${l.profit >= 0 ? '+' : ''}${fmt(l.profit)}</b></span></div>`).join('');
  }
  function renderContract() {
    const groups = {};
    [...new Map(st.contracts.map(e => [e.contract_type, e.contract_category])).entries()].forEach(([ct, cat]) => (groups[cat] = groups[cat] || []).push(ct));
    const ord = c => { const i = CAT_ORDER.indexOf(c); return i < 0 ? 99 : i; };
    setOpts(F('cType'), Object.entries(groups).sort((a, b) => ord(a[0]) - ord(b[0]))
      .map(([cat, cts]) => `<optgroup label="${CAT_NAMES[cat] || cat}">${cts.map(ct => `<option value="${ct}">${CT_NAMES[ct] || ct}</option>`).join('')}</optgroup>`).join('') || '<option>loading…</option>');
    F('cType').value = cfg.cType;
    const e = entryFor(), cat = e?.contract_category;
    const show = (c, on) => { q(`[data-c="${c}"]`).style.display = on ? '' : 'none'; };
    const hasDur = !!e && !noExpiry(e);
    show('dur', hasDur);
    if (hasDur) {
      const units = [...new Set(entriesFor(cfg.cType).flatMap(x => UNITS[x.expiry_type] || []))];
      setOpts(F('cUnit'), units.map(u => `<option value="${u}">${UNIT_NAMES[u]}</option>`).join(''));
      F('cUnit').value = cfg.cUnit; setVal(F('cDur'), cfg.cDur);
    }
    show('digit', cat === 'digits' && e.barriers === 1);
    if (e?.last_digit_range) { setOpts(F('cDigit'), e.last_digit_range.map(d => `<option>${d}</option>`).join('')); F('cDigit').value = cfg.cDigit; }
    const two = TWO_BAR.includes(cat);
    show('bar', ONE_BAR.includes(cat) || two); show('bar2', two);
    V('barLbl').textContent = two ? 'High barrier' : 'Barrier';
    setVal(F('cBar'), cfg.cBar); setVal(F('cBar2'), cfg.cBar2);
    setOpts(q('#dtb-bars'), st.barChoices.map(b => `<option value="${b}">`).join(''));
    show('tick', cat === 'highlowticks'); F('cTick').value = cfg.cTick;
    show('mult', cat === 'multiplier');
    if (e?.multiplier_range) { setOpts(F('cMult'), e.multiplier_range.map(x => `<option value="${x}">x${x}</option>`).join('')); F('cMult').value = cfg.cMult; }
    show('growth', cat === 'accumulator'); show('acc', cat === 'accumulator');
    if (e?.growth_rate_range) { setOpts(F('cGrowth'), e.growth_rate_range.map(g => `<option value="${g}">${+(g * 100).toFixed(2)}%</option>`).join('')); F('cGrowth').value = cfg.cGrowth; }
    show('ctp', cat === 'multiplier' || cat === 'accumulator'); show('csl', cat === 'multiplier');
    setVal(F('cTP'), cfg.cTP); setVal(F('cSL'), cfg.cSL); setVal(F('cAccTicks'), cfg.cAccTicks); setVal(F('stake'), cfg.stake);
    q('[data-card="digits"]').style.display = cat === 'digits' ? '' : 'none';
    let note = !e ? 'Loading trade types for this market…'
      : simFor(customParams(1)) ? 'Paper mode can simulate this trade (approximation of Deriv\'s rules).' : 'Paper can\'t simulate this one – switch Mode to Account and use a Demo account.';
    if (cat === 'multiplier' && !(cfg.cTP > 0 || cfg.cSL > 0)) note += ' Set a Contract TP or SL so each multiplier trade closes.';
    if (cat === 'accumulator') note += ` Take profit is the stake growth after ${Math.round(cfg.cAccTicks)} ticks: stake × ((1+growth)^ticks − 1).`;
    V('cnote').textContent = note;
  }
  const ruleKeys = () => Object.keys(RULES).filter(k => !RULES[k].digits || digitCat());
  function renderRule() {
    if (!ruleKeys().includes(cfg.rule)) { cfg.rule = 'manual'; saveCfg(); }
    setOpts(F('rule'), ruleKeys().map(k => `<option value="${k}">${RULES[k].name}</option>`).join(''));
    F('rule').value = cfg.rule;
    const r = RULES[cfg.rule];
    [0, 1].forEach(i => {
      const box = q(`[data-r="${i}"]`), def = r.p[i];
      box.style.visibility = def ? 'visible' : 'hidden';
      if (!def) return;
      V('rl' + i).textContent = def[0];
      const el = F('rp' + i); el.min = def[2]; el.step = def[3];
      setVal(el, ruleP(i));
    });
    V('rdesc').textContent = r.desc;
    if (!st.digits.length || !entryFor()) return;
    const sig = evalRule(), out = sig.go ? resolve(customParams(1), sig) : null, el = V('sig');
    el.className = sig.go ? 'go' : '';
    el.textContent = cfg.rule === 'manual' ? 'manual – use the Buy buttons'
      : sig.go ? (out ? `ENTRY → ${ctLabel(out)}` : 'ENTRY, but the opposite contract isn\'t offered here') + ' · ' + sig.txt : 'wait · ' + sig.txt;
    const ct = cfg.cType, directional = UPS.has(ct) || DOWNS.has(ct) || ct === 'ONETOUCH';
    V('rnote').textContent = ['trend', 'sma', 'rsi', 'bb', 'momentum', 'breakout'].includes(cfg.rule) && cfg.autoDir && !directional
      ? `${CT_NAMES[ct] || ct} has no up/down side, so the rule only decides when to enter.` : '';
  }
  const renderAll = () => { renderContract(); renderPayout(); renderRule(); renderSession(); };

  q('[data-a="reset"]').onclick = () => {
    if (inRound()) return setStatus('Wait for the open trade to finish before resetting.');
    if (!confirm(`Reset ${cfg.mode.toUpperCase()} session profit/loss and history?`)) return;
    sessions[cfg.mode] = blankSession(); st.step = 0; saveSession(cfg.mode); renderSession(); setStatus('Session reset.');
  };
  q('[data-a="release"]').onclick = () => {
    if (!st.round) return setStatus('No open trade.');
    clearInterval(st.round.poll); st.round = null; renderPayout(); setStatus('Open trade released (its result is not counted here). Check DTrader for the outcome.');
  };

  // ---------- entry rules ----------
  const ruleP = i => { const v = cfg.rp?.[cfg.rule]?.[i]; return v ?? RULES[cfg.rule].p[i]?.[1]; };
  function digitWin(ct, b) {
    const D = { DIGITMATCH: d => d === +b, DIGITDIFF: d => d !== +b, DIGITEVEN: d => d % 2 === 0, DIGITODD: d => d % 2 === 1, DIGITOVER: d => d > +b, DIGITUNDER: d => d < +b };
    return D[ct] || null;
  }
  function resolve(p, sig) {
    if (!sig) return p;
    const q2 = { ...p };
    if (sig.digit !== undefined && /^DIGIT(MATCH|DIFF|OVER|UNDER)$/.test(q2.contract_type)) q2.barrier = String(sig.digit);
    if (!cfg.autoDir || !sig.side || sig.side === 'main') return q2;
    const ct = q2.contract_type;
    if (sig.side === 'alt') return flipParams(q2);
    if (sig.side === 'even' || sig.side === 'odd') {
      if (ct !== 'DIGITEVEN' && ct !== 'DIGITODD') return q2;
      return (ct === 'DIGITEVEN') === (sig.side === 'even') ? q2 : flipParams(q2);
    }
    if (ct === 'ONETOUCH' && /^[+-]/.test(String(q2.barrier))) { q2.barrier = (sig.side === 'up' ? '+' : '-') + q2.barrier.slice(1); return q2; }
    if (UPS.has(ct)) return sig.side === 'up' ? q2 : flipParams(q2);
    if (DOWNS.has(ct)) return sig.side === 'down' ? q2 : flipParams(q2);
    return q2;
  }
  function evalRule() {
    const rule = cfg.rule, d = st.digits, px = st.prices, flip = cfg.rFlip;
    const FL = { up: 'down', down: 'up', even: 'odd', odd: 'even' };
    const dir = (go, side, txt) => ({ go, side: go && side ? (flip ? FL[side] : side) : undefined, txt });
    if (rule === 'manual') return { go: false, txt: 'manual' };
    if (!entryFor()) return { go: false, txt: 'loading…' };
    const p0 = customParams(1), dw = digitWin(p0.contract_type, p0.barrier);
    const alt = cfg.autoDir ? flipParams(p0) : null, aw = alt && digitWin(alt.contract_type, alt.barrier);
    const need = n => ({ go: false, txt: `collecting ticks (${Math.min(px.length, n)}/${n})…` });
    const N = Math.round(ruleP(0)), P2 = ruleP(1);
    if (RULES[rule].digits && !dw) return { go: false, txt: 'this rule needs a Digits trade type' };
    switch (rule) {
      case 'always': return { go: true, txt: 'every round' };
      case 'digitpct': {
        const pc = fn => WINDOWS.map(w => d.length < w ? null : d.slice(-w).filter(fn).length / w * 100);
        const ok = a => a.every(x => x !== null && x > N), mn = a => Math.min(...a.map(x => x ?? 0));
        const m = pc(dw), a = aw ? pc(aw) : null;
        const show = (p, arr) => `${ctLabel(p)} ${arr.map(x => x === null ? '…' : x.toFixed(0)).join('/')}%`;
        const txt = show(p0, m) + (a ? ' · ' + show(alt, a) : '');
        if (ok(m) && !(a && ok(a) && mn(a) > mn(m))) return { go: true, side: 'main', txt };
        if (a && ok(a)) return { go: true, side: 'alt', txt };
        return { go: false, txt };
      }
      case 'streak': {
        if (d.length < N) return need(N);
        const last = d.slice(-N), hit = fn => last.every(x => flip ? fn(x) : !fn(x)), txt = `last ${N}: ${last.join(' ')}`;
        if (hit(dw)) return { go: true, side: 'main', txt };
        if (aw && hit(aw)) return { go: true, side: 'alt', txt };
        return { go: false, txt };
      }
      case 'parity': {
        if (d.length < N) return need(N);
        const last = d.slice(-N), ev = last.every(x => x % 2 === 0), od = last.every(x => x % 2 === 1);
        return dir(ev || od, ev ? 'odd' : 'even', `last ${N}: ${last.join(' ')}`);
      }
      case 'hot': case 'cold': {
        if (d.length < N) return need(N);
        const c = Array(10).fill(0); d.slice(-N).forEach(x => c[x]++);
        const v = rule === 'hot' ? Math.max(...c) : Math.min(...c), dg = c.indexOf(v);
        return { go: true, digit: dg, txt: `digit ${dg} (${(v / N * 100).toFixed(0)}% of last ${N})` };
      }
      case 'lastdigit': return { go: d[d.length - 1] === N, txt: `last digit ${d[d.length - 1] ?? '-'}, waiting for ${N}` };
      case 'trend': {
        if (px.length < N + 1) return need(N + 1);
        const df = px.slice(-N - 1).map((x, i, a) => i ? x - a[i - 1] : 0).slice(1);
        const up = df.every(x => x > 0), dn = df.every(x => x < 0);
        return dir(up || dn, up ? 'up' : 'down', `last ${N} moves: ${df.map(x => x > 0 ? '▲' : x < 0 ? '▼' : '•').join('')}`);
      }
      case 'sma': {
        const S = Math.round(P2);
        if (px.length < S + 1) return need(S + 1);
        const ma = (n, off) => mean(px.slice(px.length - off - n, px.length - off));
        const f1 = ma(N, 0), s1 = ma(S, 0), f0 = ma(N, 1), s0 = ma(S, 1);
        const up = f0 <= s0 && f1 > s1, dn = f0 >= s0 && f1 < s1;
        return dir(up || dn, up ? 'up' : 'down', `fast ${f1.toFixed(st.pip)} ${f1 > s1 ? '>' : '<'} slow ${s1.toFixed(st.pip)}${up ? ' – crossed up' : dn ? ' – crossed down' : ''}`);
      }
      case 'rsi': {
        if (px.length < N + 1) return need(N + 1);
        let g = 0, l = 0;
        px.slice(-N - 1).forEach((x, i, a) => { if (i) { const c = x - a[i - 1]; if (c > 0) g += c; else l -= c; } });
        const rsi = l === 0 ? 100 : 100 - 100 / (1 + g / l);
        return dir(rsi < P2 || rsi > 100 - P2, rsi < P2 ? 'up' : 'down', `RSI(${N}) ${rsi.toFixed(1)} (levels ${P2} / ${100 - P2})`);
      }
      case 'bb': {
        if (px.length < N) return need(N);
        const a = px.slice(-N), m = mean(a), sd = Math.sqrt(mean(a.map(x => (x - m) ** 2))), x = px[px.length - 1];
        const lo = m - P2 * sd, hi = m + P2 * sd;
        return dir(x < lo || x > hi, x < lo ? 'up' : 'down', `price ${x.toFixed(st.pip)} · bands ${lo.toFixed(st.pip)} – ${hi.toFixed(st.pip)}`);
      }
      case 'momentum': {
        const M = Math.max(N, 50);
        if (px.length < M + 1) return need(M + 1);
        const df = px.slice(-M - 1).map((x, i, a) => i ? Math.abs(x - a[i - 1]) : 0).slice(1), avg = mean(df) || 1e-9;
        const mv = px[px.length - 1] - px[px.length - 1 - N];
        return dir(Math.abs(mv) > P2 * avg, mv > 0 ? 'up' : 'down', `move ${mv >= 0 ? '+' : ''}${mv.toFixed(st.pip)} = ${(Math.abs(mv) / avg).toFixed(1)}× avg tick`);
      }
      case 'breakout': {
        if (px.length < N + 1) return need(N + 1);
        const prev = px.slice(-N - 1, -1), x = px[px.length - 1], hi = Math.max(...prev), lo = Math.min(...prev);
        return dir(x > hi || x < lo, x > hi ? 'up' : 'down', `price ${x.toFixed(st.pip)} vs ${N}-tick range ${lo.toFixed(st.pip)} – ${hi.toFixed(st.pip)}`);
      }
      case 'quiet': {
        if (px.length < 101) return need(101);
        const mv = n => mean(px.slice(-n - 1).map((x, i, a) => i ? Math.abs(x - a[i - 1]) : 0).slice(1));
        const recent = mv(N), avg = mv(100) || 1e-9;
        return { go: recent <= P2 * avg, txt: `recent ${(recent / avg).toFixed(2)}× the 100-tick average move (max ${P2}×)` };
      }
    }
    return { go: false, txt: '-' };
  }

  // ---------- paper simulation (tick-based contracts) ----------
  // Entry spot = first tick after buying. Approximation of Deriv's rules.
  function simFor(p) {
    const ct = p.contract_type, b = p.barrier, b2 = p.barrier2;
    if (p.duration_unit !== 't' || !p.duration) return null;
    const n = Math.round(p.duration);
    const r = v => +(+v).toFixed(st.pip), dig = v => lastDigit(v, st.pip);
    const bar = (e, s) => (/^[+-]/.test(String(s)) ? r(e + parseFloat(s)) : r(s));
    const dw = digitWin(ct, b);
    if (dw) return { need: n, win: t => dw(dig(t[n - 1])), digit: t => dig(t[n - 1]) };
    const C = { CALL: (e, x) => x > e, PUT: (e, x) => x < e, CALLE: (e, x) => x >= e, PUTE: (e, x) => x <= e };
    if (C[ct]) return { need: n + 1, win: t => C[ct](r(t[0]), r(t[n])) };
    if (ct === 'HIGHER' || ct === 'LOWER') return { need: n + 1, win: t => { const B = bar(r(t[0]), b), x = r(t[n]); return ct === 'HIGHER' ? x > B : x < B; } };
    if (ct === 'ONETOUCH' || ct === 'NOTOUCH') return { need: n + 1, win: t => {
      const e = r(t[0]), B = bar(e, b), up = B > e;
      const touched = t.slice(1, n + 1).some(v => (up ? r(v) >= B : r(v) <= B));
      return ct === 'ONETOUCH' ? touched : !touched;
    } };
    if (ct === 'ASIANU' || ct === 'ASIAND') return { need: n + 1, win: t => { const a = mean(t.slice(0, n + 1)), x = t[n]; return ct === 'ASIANU' ? x > a : x < a; } };
    if (ct === 'RUNHIGH' || ct === 'RUNLOW') return { need: n + 1, win: t => {
      for (let i = 1; i <= n; i++) if (ct === 'RUNHIGH' ? !(t[i] > t[i - 1]) : !(t[i] < t[i - 1])) return false;
      return true;
    } };
    if (ct === 'TICKHIGH' || ct === 'TICKLOW') { const k = Math.max(1, Math.round(p.selected_tick || 1)) - 1;
      return { need: 5, win: t => { const v = t[k]; return t.slice(0, 5).every((x, i) => i === k || (ct === 'TICKHIGH' ? x < v : x > v)); } }; }
    if (/^EXPIRY(RANGE|MISS)E?$/.test(ct)) return { need: n + 1, win: t => {
      const e = r(t[0]), hi = bar(e, b), lo = bar(e, b2), x = r(t[n]);
      const inside = ct.endsWith('E') ? x >= lo && x <= hi : x > lo && x < hi;
      return ct.startsWith('EXPIRYRANGE') ? inside : !inside;
    } };
    if (ct === 'RANGE' || ct === 'UPORDOWN') return { need: n + 1, win: t => {
      const e = r(t[0]), hi = bar(e, b), lo = bar(e, b2);
      const out = t.slice(1, n + 1).some(v => r(v) >= hi || r(v) <= lo);
      return ct === 'RANGE' ? !out : out;
    } };
    if (ct === 'RESETCALL' || ct === 'RESETPUT') { const m = Math.floor(n / 2);
      return { need: n + 1, win: t => ct === 'RESETCALL' ? t[n] > Math.min(t[0], t[m]) : t[n] < Math.max(t[0], t[m]) }; }
    return null;
  }

  // ---------- trading connection (uses your DTrader login) ----------
  let trWs, trPing, reqId = 0;
  const pending = new Map();
  const trSend = o => {
    if (!trWs || trWs.readyState !== 1) return Promise.reject(new Error('Trading connection not ready'));
    const id = ++reqId;
    trWs.send(JSON.stringify({ ...o, req_id: id }));
    return new Promise((res, rej) => {
      pending.set(id, { res, rej });
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('Timeout')); } }, 20000);
    });
  };
  const accountId = () => localStorage.getItem('account_id');
  const accountType = id => id?.startsWith('DOT') ? 'demo' : id?.startsWith('ROT') ? 'real' : null;
  function connectTrading() {
    clearInterval(trPing);
    const id = accountId(), type = accountType(id);
    st.account = id; st.tradeReady = false;
    if (!type) { V('acc').textContent = 'not logged in (needed for Account mode only)'; V('bal').textContent = '-'; return; }
    V('acc').textContent = `${id} (${type.toUpperCase()}) connecting…`;
    const ws = new WebSocket(`${TRADE_WS_BASE}/${type}?account_id=${encodeURIComponent(id)}`);
    trWs = ws;
    ws.onopen = () => {
      trPing = setInterval(() => trSend({ ping: 1 }).catch(() => {}), 30000);
      ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));
    };
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      const p = m.req_id && pending.get(m.req_id);
      if (m.msg_type === 'balance' && !m.error) {
        st.tradeReady = true; st.currency = m.balance.currency || st.currency; st.balance = m.balance.balance;
        V('acc').textContent = `${id} (${type.toUpperCase()})`;
        V('bal').textContent = `${fmt(st.balance)} ${st.currency}`;
        renderSession();
      } else if (m.msg_type === 'balance' && m.error) V('acc').textContent = `${id}: ${m.error.message}`;
      if (m.msg_type === 'proposal_open_contract') onContractUpdate(m);
      if (p && m.msg_type !== 'proposal_open_contract') {
        pending.delete(m.req_id);
        m.error ? p.rej(Object.assign(new Error(m.error.message), { code: m.error.code })) : p.res(m);
      }
    };
    ws.onclose = () => {
      clearInterval(trPing);
      if (trWs !== ws) return;
      st.tradeReady = false;
      V('acc').textContent = `${id || ''} disconnected – reconnecting…`;
      setTimeout(() => { if (trWs === ws) connectTrading(); }, 3000);
    };
  }
  setInterval(() => {
    if (accountId() !== st.account && !inRound()) { const old = trWs; trWs = null; if (old) old.close(); connectTrading(); renderSession(); }
  }, 2000);

  // ---------- bot + manual trades ----------
  const btn = q('[data-a="toggle"]');
  function setRunning(on, why) {
    st.running = on;
    btn.textContent = on ? 'STOP AUTO BOT' : 'START AUTO BOT';
    btn.classList.toggle('stop', on);
    q('.dtb-dot').classList.toggle('on', on);
    if (why) setStatus(why);
  }
  function tradeProblem(auto) {
    const s = sess(), e = entryFor();
    if (cfg.mode === 'live' && !st.tradeReady) return 'Account mode: not connected. Log in to DTrader (Demo first!) and wait for the balance to show.';
    if (+cfg.stake < 0.35) return 'Stake must be at least 0.35.';
    if (!e) return 'Trade types are still loading for this market.';
    if (e.contract_category === 'multiplier' && !(cfg.cTP > 0 || cfg.cSL > 0)) return 'Set a Contract TP or SL for multipliers so each trade closes.';
    if (cfg.mode === 'paper') {
      if (!simFor(customParams(1))) return `Paper can't simulate ${CT_NAMES[cfg.cType] || cfg.cType} – switch Mode to Account and use a Demo account.`;
      if (!st.quotes?.main?.ratio) return 'No valid payout from Deriv for these settings yet.';
    }
    if (cfg.takeProfit > 0 && s.pl >= cfg.takeProfit) return 'Session take profit already reached – reset P/L to continue.';
    if (cfg.stopLoss > 0 && s.pl <= -cfg.stopLoss) return 'Session stop loss already reached – reset P/L to continue.';
    if (auto && cfg.rule === 'manual') return 'Strategy is "Manual only". Pick a strategy, or use the Buy buttons.';
    if (auto && RULES[cfg.rule].digits && !digitCat()) return 'That strategy needs a Digits trade type.';
    return null;
  }
  let realAsked = false;
  const realOk = () => cfg.mode !== 'live' || accountType(st.account) !== 'real' || realAsked || (realAsked = confirm('You are on a REAL account. Trade with real money?'));

  btn.onclick = () => {
    if (st.running) return setRunning(false, inRound() ? 'Stopping after the open trade settles…' : 'Bot stopped.');
    const prob = tradeProblem(true);
    if (prob) return setStatus(prob);
    if (!realOk()) return;
    st.runTrades = 0; st.cool = 0;
    unlockAudio(); renderSession();
    setRunning(true, `Running (${cfg.mode}) – waiting for a signal…`);
  };
  const manualBuy = side => {
    if (inRound()) return setStatus('A trade is already open – wait for it to finish.');
    const prob = tradeProblem(false);
    if (prob) return setStatus(prob);
    if (!realOk()) return;
    unlockAudio();
    openRound(null, side);
  };
  q('[data-a="buy-main"]').onclick = () => manualBuy('main');
  q('[data-a="buy-alt"]').onclick = () => manualBuy('alt');

  function maybeTrade() {
    if (!st.running || inRound()) return;
    if (cfg.mode === 'live' && !st.tradeReady) return;
    if (st.cool > 0) { st.cool--; return setStatus(`Pausing between trades – ${st.cool + 1} tick(s) left…`); }
    st.sig = evalRule();
    if (st.sig.go) openRound(st.sig, 'auto');
  }

  function openRound(sig, side) {
    const useMart = side === 'auto' || cfg.martManual;
    const stake = useMart ? nextStake() : r2(stakeNow());
    if (cfg.stopLoss > 0 && sess().pl - stake < -cfg.stopLoss - 1e-9) {
      const msg = 'Next trade could take the session past your stop loss – not placed.';
      if (st.running) { setRunning(false, 'Stopped: ' + msg); alertStop('sl', cfg.mode, 'The next stake would go past your stop loss.'); } else setStatus(msg);
      return;
    }
    const p0 = customParams(stake);
    const params = side === 'main' ? p0 : side === 'alt' ? flipParams(p0) : resolve(p0, sig);
    if (!params) return setStatus('The opposite contract isn\'t offered on this market.');
    const qt = params.contract_type === p0.contract_type ? st.quotes?.main : st.quotes?.alt;
    const leg = { key: params.contract_type + (params.barrier !== undefined && /^DIGIT/.test(params.contract_type) ? ' ' + params.barrier : ''),
      label: ctLabel(params), stake, ratio: qt?.ratio || null, pct: qt?.ratio ? (qt.ratio - 1) * 100 : null, params, sim: simFor(params) };
    if (cfg.mode === 'paper' && (!leg.sim || !leg.ratio)) return setStatus('Paper can\'t price/simulate this trade right now.');
    const round = { mode: cfg.mode, sym: cfg.symbol, stake, ticks: [], leg, mart: useMart };
    st.round = round; renderPayout();
    if (round.mode === 'paper') return setStatus(`[PAPER] ${leg.label} @ ${fmt(stake)}${leg.pct != null ? ` (payout +${leg.pct.toFixed(0)}%)` : ''} – waiting for result…`);
    buyLive(round);
  }
  function paperCheck() {
    const r = st.round;
    if (!r || r.mode !== 'paper') return;
    r.ticks.push(+st.quote);
    const l = r.leg;
    if (r.ticks.length < l.sim.need) return;
    const win = l.sim.win(r.ticks);
    settleRound(r, win ? r2(l.stake * (l.ratio - 1)) : -l.stake, l.sim.digit ? l.sim.digit(r.ticks) : undefined);
  }
  async function buyLive(r) {
    const l = r.leg;
    setStatus(`Buying ${l.label} on ${symName(r.sym)} for ${fmt(r.stake)}${l.pct != null ? ` (payout +${l.pct.toFixed(0)}%)` : ''}…`);
    try {
      const res = await trSend({ buy: 1, price: l.stake, parameters: { ...l.params, currency: st.currency } });
      l.cid = res.buy.contract_id; l.buy = +res.buy.buy_price || l.stake;
      trWs.send(JSON.stringify({ proposal_open_contract: 1, contract_id: l.cid, subscribe: 1 }));
    } catch (e) {
      st.round = null; renderPayout();
      return st.running ? setRunning(false, `Buy failed: ${e.message}. Bot stopped.`) : setStatus(`Buy failed: ${e.message}`);
    }
    setStatus(`Bought ${l.label} #${l.cid}. Waiting for result…`);
    r.poll = setInterval(() => { if (l.cid && !l.done && trWs && trWs.readyState === 1) trWs.send(JSON.stringify({ proposal_open_contract: 1, contract_id: l.cid })); }, 5000);
  }
  function onContractUpdate(m) {
    const r = st.round;
    if (m.error || !r || r.mode !== 'live') return;
    const c = m.proposal_open_contract, l = r.leg;
    if (!c || String(c.contract_id) !== String(l.cid) || l.done) return;
    const sold = c.is_sold === 1 || c.is_sold === true || String(c.is_sold) === '1' || ['won', 'lost', 'sold'].includes(c.status) || (c.is_expired && c.exit_tick_time && c.status !== 'open');
    if (!sold) return;
    l.done = true;
    if (m.subscription?.id) trWs.send(JSON.stringify({ forget: m.subscription.id }));
    const profit = c.profit !== undefined ? +c.profit : (+c.sell_price || 0) - l.buy;
    const ex = String(c.exit_tick_display_value ?? c.exit_tick ?? '');
    settleRound(r, profit, digitCat() && ex ? +ex.slice(-1) : undefined);
  }
  function settleRound(r, profit, digit) {
    if (r.settled) return;
    r.settled = true; clearInterval(r.poll); st.round = null;
    const s = sessions[r.mode]; profit = r2(profit);
    s.pl = r2(s.pl + profit); s.trades++;
    const win = profit > 0;
    if (win) { s.wins++; s.streak = 0; } else { s.losses++; s.streak = (s.streak || 0) + 1; }
    s.worstStreak = Math.max(s.worstStreak || 0, s.streak);
    s.peak = Math.max(s.peak || 0, s.pl); s.maxDD = Math.max(s.maxDD || 0, r2(s.peak - s.pl));
    s.log.unshift({ t: new Date().toLocaleTimeString(), type: r.leg.label, sym: r.sym, stake: r.stake, profit, digit, pct: r.leg.pct });
    s.log = s.log.slice(0, 100); saveSession(r.mode);
    if (st.running) { st.runTrades++; st.cool = cfg.cooldown > 0 ? Math.round(cfg.cooldown) : 0; }
    let capped = false;
    if (r.mart) {
      if (win) st.step = 0;
      else {
        st.step++;
        if ((cfg.maxSteps > 0 && st.step > cfg.maxSteps) || (cfg.maxStake > 0 && nextStake() > cfg.maxStake + 1e-9)) { st.step = 0; capped = true; }
      }
    }
    renderSession();
    renderPayout();
    const tag = r.mode === 'paper' ? '[PAPER] ' : '';
    const res = `${tag}${win ? 'WON' : 'LOST'} ${win ? '+' : ''}${fmt(profit)}.`;
    if (cfg.toasts) toast(`${tag}${win ? 'WON +' : 'LOST '}${fmt(profit)}`, `${r.leg.label} · session ${s.pl >= 0 ? '+' : ''}${fmt(s.pl)}`, win ? 'win' : 'loss');
    if (cfg.takeProfit > 0 && s.pl >= cfg.takeProfit) { setRunning(false, `${res} Take profit reached (${fmt(s.pl)}). Bot stopped.`); return alertStop('tp', r.mode, `Target ${fmt(cfg.takeProfit)} reached`); }
    if (cfg.stopLoss > 0 && s.pl <= -cfg.stopLoss) { setRunning(false, `${res} Stop loss reached (${fmt(s.pl)}). Bot stopped.`); return alertStop('sl', r.mode, `Limit ${fmt(cfg.stopLoss)} reached`); }
    tone(win ? 'win' : 'loss');
    if (!st.running) return setStatus(`${res}`);
    if (cfg.maxLossRow > 0 && s.streak >= cfg.maxLossRow) { setRunning(false, `${res} ${s.streak} losses in a row – bot stopped.`); return alertStop('stop', r.mode, `${s.streak} losses in a row`); }
    if (cfg.maxTrades > 0 && st.runTrades >= cfg.maxTrades) { setRunning(false, `${res} ${st.runTrades} trades done – bot stopped.`); return alertStop('stop', r.mode, `Max trades (${cfg.maxTrades}) reached`); }
    setStatus(`${res}${capped ? ' Max reached – back to base stake.' : ''} Next stake ${fmt(nextStake())}. Waiting for the next signal…`);
  }

  // ---------- alerts ----------
  let actx = null;
  function unlockAudio() { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch (e) { /* no audio */ } }
  const SOUNDS = {
    win: [[880, .1], [1318, .2]], loss: [[220, .32, 'sawtooth', .1]], stop: [[660, .15], [440, .35]],
    tp: [[523, .13], [659, .13], [784, .13], [1047, .5]], sl: [[440, .25, 'square', .08], [349, .25, 'square', .08], [262, .6, 'square', .08]],
  };
  function tone(kind) {
    if (!cfg.sound) return;
    unlockAudio();
    if (!actx) return;
    let t = actx.currentTime + .03;
    SOUNDS[kind].forEach(([f, d, type = 'sine', vol = .2]) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = type; o.frequency.value = f;
      g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + .015); g.gain.exponentialRampToValueAtTime(.0001, t + d);
      o.connect(g); g.connect(actx.destination); o.start(t); o.stop(t + d + .05);
      t += d * .85;
    });
  }
  const toastBox = document.createElement('div');
  toastBox.id = 'dtb-toasts';
  document.body.appendChild(toastBox);
  function toast(title, sub, cls) {
    const el = document.createElement('div');
    el.className = 'dtb-toast ' + cls;
    el.innerHTML = `${title}<small>${sub}</small>`;
    toastBox.prepend(el);
    while (toastBox.children.length > 4) toastBox.lastChild.remove();
    setTimeout(() => el.classList.add('out'), 3200);
    setTimeout(() => el.remove(), 3700);
  }
  function alertStop(kind, mode, reason) {
    tone(kind);
    if (!cfg.popups) return;
    document.getElementById('dtb-pop')?.remove();
    const s = sessions[mode], pop = document.createElement('div');
    pop.id = 'dtb-pop'; pop.className = kind;
    pop.innerHTML = `<div class="dtb-pc"><div class="ttl">${{ tp: 'TAKE PROFIT HIT', sl: 'STOP LOSS HIT', stop: 'BOT STOPPED' }[kind]}</div>
      <div class="sub">${mode === 'paper' ? 'PAPER · ' : 'LIVE · '}${reason}</div>
      <div class="amt">${s.pl > 0 ? '+' : ''}${fmt(s.pl)} ${mode === 'paper' ? 'USD' : st.currency}</div>
      <div class="mini">${s.trades} trades · ${s.wins} wins · ${s.losses} losses · ${s.trades ? (s.wins / s.trades * 100).toFixed(0) : 0}% win rate<br>${mode === 'paper' ? 'Paper balance' : 'Balance'}: ${balanceText(mode)}</div>
      <div class="btns"><button data-p="reset">Reset P/L</button><button data-p="close">Close</button></div></div>`;
    pop.addEventListener('click', e => {
      const a = e.target.dataset.p;
      if (a === 'reset' && !inRound()) { sessions[mode] = blankSession(); st.step = 0; saveSession(mode); renderSession(); setStatus('Session reset.'); }
      if (a || e.target === pop) pop.remove();
    });
    document.body.appendChild(pop);
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape') document.getElementById('dtb-pop')?.remove(); });

  // ---------- start ----------
  renderAll();
  checkDtraderSymbol();
  connectPublic();
  connectTrading();
})();