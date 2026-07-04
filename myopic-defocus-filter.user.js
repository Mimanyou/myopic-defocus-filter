// ==UserScript==
// @name         近视防控离焦滤镜 (Myopic Defocus Filter)
// @namespace    https://github.com/myopic-defocus-filter
// @version      0.3.0
// @description  基于LCA纵向色差物理模型，自动检测屏幕参数，电脑/手机双模式
// @author       MVP
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* ================================================================
   *  LCA 物理模型常量（Thibos 眼模型）
   * ================================================================ */

  const LCA_R = -0.23;  // 红光屈光度偏移
  const LCA_G_RAW = 0.24;
  const LCA_B_RAW = 1.10;
  const SHIFT = -LCA_R;                  // 0.23
  const LCA_G = LCA_G_RAW + SHIFT;      // 0.47 D
  const LCA_B = LCA_B_RAW + SHIFT;      // 1.33 D
  const GLOBAL_SCALE = 0.32;            // 经验缩放系数

  /* ================================================================
   *  场景预设：电脑 / 手机
   * ================================================================ */

  const SCENARIOS = {
    desktop: {
      label: '🖥 电脑',
      distanceCm: 50,      // 电脑观看距离 ~50cm
      pupilMm: 3.5,        // 室内瞳孔偏保守
      strength: 15,         // 默认强度 15%
    },
    mobile: {
      label: '📱 手机',
      distanceCm: 30,      // 手机观看距离 ~30cm
      pupilMm: 3.0,        // 更小瞳孔（手机通常环境更亮）
      strength: 12,         // 手机屏幕小，强度略低
    },
  };

  /* ================================================================
   *  自动检测屏幕模式
   * ================================================================ */

  function detectMode() {
    const ua = navigator.userAgent.toLowerCase();
    // 判断是否为移动设备
    const isMobile = /android|iphone|ipod|ipad|mobile/i.test(ua);
    // 也通过屏幕宽度辅助判断（窗口 < 768px 视为移动）
    const isSmallScreen = window.innerWidth < 768;
    return (isMobile || isSmallScreen) ? 'mobile' : 'desktop';
  }

  function getEffectiveDPI() {
    // 尝试获取设备像素比
    const dpr = window.devicePixelRatio || 1;
    const cssW = screen.width * dpr;
    const cssH = screen.height * dpr;
    return { cssW, cssH, dpr };
  }

  /* ================================================================
   *  LCA 模糊半径计算（自动检测屏幕参数）
   * ================================================================ */

  function calcBlurCircles() {
    const mode = config.mode || detectMode();
    const scenario = SCENARIOS[mode] || SCENARIOS.desktop;
    const d = scenario.distanceCm * 10;           // mm
    const pupil = scenario.pupilMm;               // mm

    // 用 CSS 像素和 devicePixelRatio 估算物理尺寸
    const { cssW, cssH, dpr } = getEffectiveDPI();
    const resX = cssW;
    const resY = cssH;
    const diagPx = Math.sqrt(resX * resX + resY * resY);

    // 估算屏幕对角线物理尺寸（英寸）
    // 基于常见 PPI：桌面 ~100-140 DPI，手机 ~300-450 DPI
    const isMobile = (mode === 'mobile');
    const estPPI = isMobile
      ? 320 + (dpr - 2) * 40          // 手机：基准 320 PPI，高 DPI 设备更高
      : 90 + (dpr - 1) * 20;           // 桌面：基准 90 PPI
    const diagInch = diagPx / estPPI;

    const aspect = resX / resY;
    const h_mm = diagInch * 25.4 / Math.sqrt(aspect * aspect + 1);
    const pix_mm = h_mm / resX;

    function channelBlur(lca_diopter) {
      const G = 1000 / (1000 / d + lca_diopter);
      const circ = pupil * ((d - G) / G);
      return Math.max(0, (circ / pix_mm) * GLOBAL_SCALE);
    }

    const blur_b = channelBlur(LCA_B);
    const blur_g = channelBlur(LCA_G);

    return {
      blur_b, blur_g,
      mode,
      scenario,
      screenInfo: {
        cssW: Math.round(cssW),
        cssH: Math.round(cssH),
        dpr: dpr.toFixed(1),
        estPPI: Math.round(estPPI),
        diagInch: diagInch.toFixed(1),
        pix_mm: pix_mm.toFixed(3),
      }
    };
  }

  /* ================================================================
   *  持久化
   * ================================================================ */

  const STORAGE_KEY = '__mdf_config_v3';

  const DEFAULTS = {
    enabled: false,
    mode: null,              // null = 自动检测, 'desktop', 'mobile'
    strengthOverride: null, // null = 使用场景默认值
  };

  function loadConfig() {
    try { return { ...DEFAULTS, ...JSON.parse(GM_getValue(STORAGE_KEY, '{}')) }; }
    catch { return { ...DEFAULTS }; }
  }
  function saveConfig() { GM_setValue(STORAGE_KEY, JSON.stringify(config)); }

  let config = loadConfig();

  /* ================================================================
   *  SVG Filter + backdrop-filter 覆盖层
   * ================================================================ */

  const SVG_NS   = 'http://www.w3.org/2000/svg';
  const SVG_ID   = '__mdf_svg';
  const FILTER_ID = '__mdf_filter';
  const LAYER_ID  = '__mdf_layer';

  function injectSVGAndLayer() {
    if (document.getElementById(SVG_ID)) return;

    const { blur_b, blur_g } = calcBlurCircles();
    const mode = config.mode || detectMode();
    const scenario = SCENARIOS[mode] || SCENARIOS.desktop;
    const strength = (config.strengthOverride != null ? config.strengthOverride : scenario.strength) / 100;

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.id = SVG_ID;
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = 'position:fixed;width:0;height:0;top:-1px;left:-1px;pointer-events:none;';

    svg.innerHTML = `
      <defs>
        <filter id="${FILTER_ID}"
                x="0" y="0" width="100%" height="100%"
                color-interpolation-filters="sRGB">
          <feColorMatrix in="SourceGraphic" type="matrix" result="ch_r"
            values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"/>
          <feColorMatrix in="SourceGraphic" type="matrix" result="ch_g"
            values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"/>
          <feGaussianBlur color-interpolation-filters="sRGB"
            in="ch_g" stdDeviation="${blur_g.toFixed(2)}" result="ch_g_blur"/>
          <feColorMatrix in="SourceGraphic" type="matrix" result="ch_b"
            values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"/>
          <feGaussianBlur color-interpolation-filters="sRGB"
            in="ch_b" stdDeviation="${blur_b.toFixed(2)}" result="ch_b_blur"/>
          <feComposite color-interpolation-filters="sRGB"
            in="ch_r" in2="ch_g_blur" operator="arithmetic"
            k1="0" k2="1" k3="1" k4="0" result="rg"/>
          <feComposite color-interpolation-filters="sRGB"
            in="rg" in2="ch_b_blur" operator="arithmetic"
            k1="0" k2="1" k3="1" k4="0" result="defocused"/>
          <feComposite color-interpolation-filters="sRGB"
            in="SourceGraphic" in2="defocused" operator="arithmetic"
            k1="0"
            k2="${(1 - strength).toFixed(3)}"
            k3="${strength.toFixed(3)}"
            k4="0"
            result="final"/>
        </filter>
      </defs>`;

    document.documentElement.appendChild(svg);

    const layer = document.createElement('div');
    layer.id = LAYER_ID;
    layer.style.cssText =
      'position:fixed;top:0;right:0;bottom:0;left:0;' +
      'z-index:9998;' +
      'backdrop-filter:url(#' + FILTER_ID + ');' +
      '-webkit-backdrop-filter:url(#' + FILTER_ID + ');' +
      'pointer-events:none;' +
      'display:none;';
    document.documentElement.appendChild(layer);
  }

  function applyFilter() {
    const layer = document.getElementById(LAYER_ID);
    if (layer) layer.style.display = 'block';
  }

  function removeFilter() {
    const layer = document.getElementById(LAYER_ID);
    if (layer) layer.style.display = 'none';
  }

  function rebuildFilter() {
    const oldSvg = document.getElementById(SVG_ID);
    const oldLayer = document.getElementById(LAYER_ID);
    if (oldSvg) oldSvg.remove();
    if (oldLayer) oldLayer.remove();
    injectSVGAndLayer();
    if (config.enabled) applyFilter();
    saveConfig();
  }

  /* ================================================================
   *  用眼计时器
   * ================================================================ */

  let timerStart = null, timerSeconds = 0, timerInterval = null;

  function startTimer() {
    if (timerInterval) return;
    timerStart = Date.now() - timerSeconds * 1000;
    timerInterval = setInterval(() => {
      timerSeconds = Math.floor((Date.now() - timerStart) / 1000);
      const el = document.getElementById('__mdf_timer');
      if (el) el.textContent = fmtTime(timerSeconds);
    }, 1000);
  }
  function stopTimer() { clearInterval(timerInterval); timerInterval = null; }
  function resetTimer() {
    stopTimer(); timerSeconds = 0;
    const el = document.getElementById('__mdf_timer');
    if (el) el.textContent = '00:00:00';
  }
  function fmtTime(s) {
    const h = String(Math.floor(s / 3600)).padStart(2, '0');
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${h}:${m}:${ss}`;
  }

  /* ================================================================
   *  控制面板 UI
   * ================================================================ */

  const PANEL_ID = '__mdf_panel';

  GM_addStyle(`
    #__mdf_panel *{box-sizing:border-box;margin:0;padding:0}
    #__mdf_panel{
      position:fixed;bottom:20px;right:20px;z-index:2147483647;
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
      font-size:13px;color:#e2e8f0;user-select:none;
      width:280px;border-radius:14px;overflow:hidden;
      background:rgba(15,23,42,0.92);
      backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
      border:1px solid rgba(100,116,139,0.3);
      box-shadow:0 8px 32px rgba(0,0,0,0.4);
    }
    #__mdf_panel.collapsed .__mdf_body{display:none}
    #__mdf_panel.collapsed{width:auto}
    .__mdf_header{
      display:flex;align-items:center;justify-content:space-between;
      padding:10px 14px;cursor:pointer;
      background:rgba(100,116,139,0.15);
    }
    .__mdf_header:hover{background:rgba(100,116,139,0.25)}
    .__mdf_title{display:flex;align-items:center;gap:7px;font-weight:600;font-size:13px}
    .__mdf_dot{
      width:8px;height:8px;border-radius:50%;
      background:#ef4444;transition:background .3s;
    }
    .__mdf_dot.on{background:#10b981;box-shadow:0 0 6px #10b981}
    .__mdf_arrow{font-size:11px;color:#94a3b8;transition:transform .2s}
    #__mdf_panel.collapsed .__mdf_arrow{transform:rotate(180deg)}
    .__mdf_body{padding:12px 14px 14px}

    /* 场景切换 */
    .__mdf_scenes{display:flex;gap:6px;margin-bottom:14px}
    .__mdf_scene_btn{
      flex:1;padding:8px 0;border-radius:8px;cursor:pointer;text-align:center;
      font-size:13px;font-weight:500;
      background:rgba(100,116,139,0.15);color:#94a3b8;
      border:1px solid transparent;transition:all .15s;
    }
    .__mdf_scene_btn:hover{background:rgba(100,116,139,0.3);color:#cbd5e1}
    .__mdf_scene_btn.active{
      background:rgba(13,148,136,0.2);color:#5eead4;
      border-color:rgba(13,148,136,0.4);
    }
    .__mdf_scene_btn .scene_sub{font-size:10px;color:#64748b;margin-top:2px}

    /* 滑块 */
    .__mdf_slider_group{margin-bottom:10px}
    .__mdf_slider_label{
      display:flex;justify-content:space-between;align-items:center;
      font-size:12px;color:#94a3b8;margin-bottom:5px;
    }
    .__mdf_slider_val{
      font-family:"SF Mono","Fira Code",monospace;
      color:#5eead4;font-weight:600;font-size:12px;
    }
    input.__mdf_range{
      -webkit-appearance:none;appearance:none;
      width:100%;height:4px;border-radius:2px;
      background:rgba(100,116,139,0.3);outline:none;
    }
    input.__mdf_range::-webkit-slider-thumb{
      -webkit-appearance:none;appearance:none;
      width:16px;height:16px;border-radius:50%;
      background:#0d9488;cursor:pointer;border:2px solid #134e4a;
    }
    input.__mdf_range::-moz-range-thumb{
      width:14px;height:14px;border-radius:50%;
      background:#0d9488;cursor:pointer;border:2px solid #134e4a;
    }

    /* 检测信息 */
    .__mdf_detect{
      padding:8px 10px;border-radius:8px;margin-bottom:12px;
      background:rgba(100,116,139,0.1);
      border:1px solid rgba(100,116,139,0.15);
      font-size:11px;color:#64748b;line-height:1.8;
    }
    .__mdf_detect strong{color:#cbd5e1;font-weight:600}

    /* 计时器 */
    .__mdf_timer_row{
      display:flex;align-items:center;justify-content:space-between;
      padding-top:10px;border-top:1px solid rgba(100,116,139,0.2);
    }
    .__mdf_timer_info{display:flex;align-items:center;gap:6px;font-size:12px;color:#94a3b8}
    #__mdf_timer{
      font-family:"SF Mono","Fira Code",monospace;
      font-size:14px;font-weight:600;color:#e2e8f0;
    }
    .__mdf_btn_s{
      padding:3px 8px;border-radius:4px;cursor:pointer;
      font-size:11px;color:#94a3b8;
      background:rgba(100,116,139,0.2);border:1px solid transparent;
    }
    .__mdf_btn_s:hover{color:#e2e8f0;background:rgba(100,116,139,0.35)}

    /* 原理 */
    .__mdf_info{
      margin-top:10px;padding:8px 10px;border-radius:8px;
      background:rgba(13,148,136,0.08);
      border:1px solid rgba(13,148,136,0.15);
      font-size:11px;color:#64748b;line-height:1.6;
    }
    .__mdf_info strong{color:#5eead4;font-weight:600}
  `);

  function createPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const calc = calcBlurCircles();
    const effectiveMode = config.mode || detectMode();
    const effectiveStrength = config.strengthOverride != null
      ? config.strengthOverride
      : (SCENARIOS[effectiveMode] || SCENARIOS.desktop).strength;

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = config.enabled ? '' : 'collapsed';

    panel.innerHTML = `
      <div class="__mdf_header" id="__mdf_header">
        <div class="__mdf_title">
          <span class="__mdf_dot ${config.enabled ? 'on' : ''}" id="__mdf_dot"></span>
          <span>近视防控滤镜</span>
        </div>
        <span class="__mdf_arrow">▼</span>
      </div>

      <div class="__mdf_body">
        <!-- 场景选择 -->
        <div class="__mdf_scenes">
          <div class="__mdf_scene_btn ${effectiveMode === 'desktop' ? 'active' : ''}" data-mode="desktop">
            🖥 电脑
            <div class="scene_sub">~50cm</div>
          </div>
          <div class="__mdf_scene_btn ${effectiveMode === 'mobile' ? 'active' : ''}" data-mode="mobile">
            📱 手机
            <div class="scene_sub">~30cm</div>
          </div>
        </div>

        <!-- 强度滑块 -->
        <div class="__mdf_slider_group">
          <div class="__mdf_slider_label">
            <span>效果强度</span>
            <span class="__mdf_slider_val" id="__mdf_str_val">${effectiveStrength}%</span>
          </div>
          <input type="range" class="__mdf_range" id="__mdf_str_range"
                 min="5" max="40" step="1" value="${effectiveStrength}">
        </div>

        <!-- 自动检测信息 -->
        <div class="__mdf_detect" id="__mdf_detect">
          屏幕：<strong id="__mdf_det_screen">${calc.screenInfo.cssW}×${calc.screenInfo.cssH}</strong>
          （DPR <strong>${calc.screenInfo.dpr}</strong>，
          ≈<strong>${calc.screenInfo.estPPI}</strong> PPI，
          ≈<strong>${calc.screenInfo.diagInch}"</strong>）<br>
          模糊半径：蓝 <strong id="__mdf_det_b">${calc.blur_b.toFixed(1)}px</strong>
          绿 <strong id="__mdf_det_g">${calc.blur_g.toFixed(1)}px</strong>
        </div>

        <!-- 计时器 -->
        <div class="__mdf_timer_row">
          <div class="__mdf_timer_info">
            <span>⏱</span>
            <span id="__mdf_timer">${fmtTime(timerSeconds)}</span>
          </div>
          <div class="__mdf_btn_s" id="__mdf_timer_reset">重置</div>
        </div>

        <div class="__mdf_info">
          <strong>LCA 色差模拟：</strong>分离 RGB 三通道，蓝光（+1.33D）模糊最多、红光不模糊，
          模拟<strong>近视性离焦</strong>信号，辅助抑制眼轴增长。与原图按强度混合保持可读性。
        </div>
      </div>
    `;

    document.documentElement.appendChild(panel);
    bindEvents(panel);
  }

  /* ================================================================
   *  事件绑定
   * ================================================================ */

  function bindEvents(panel) {
    // 折叠
    panel.querySelector('#__mdf_header').addEventListener('click', () => {
      panel.classList.toggle('collapsed');
    });

    // 场景切换
    panel.querySelectorAll('.__mdf_scene_btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const newMode = btn.dataset.mode;
        config.mode = newMode;
        config.strengthOverride = null;  // 重置为场景默认强度
        panel.querySelectorAll('.__mdf_scene_btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        // 更新强度滑块为场景默认值
        const scenario = SCENARIOS[newMode] || SCENARIOS.desktop;
        const strR = panel.querySelector('#__mdf_str_range');
        strR.value = scenario.strength;
        panel.querySelector('#__mdf_str_val').textContent = scenario.strength + '%';
        updateDetectDisplay();
        rebuildFilter();
      });
    });

    // 强度滑块
    const strR = panel.querySelector('#__mdf_str_range');
    strR.addEventListener('input', () => {
      config.strengthOverride = parseInt(strR.value);
      panel.querySelector('#__mdf_str_val').textContent = config.strengthOverride + '%';
      rebuildFilter();
    });

    // 重置计时
    panel.querySelector('#__mdf_timer_reset').addEventListener('click', (e) => {
      e.stopPropagation();
      resetTimer();
    });
  }

  function updateDetectDisplay() {
    const calc = calcBlurCircles();
    const elB = document.getElementById('__mdf_det_b');
    const elG = document.getElementById('__mdf_det_g');
    const elScreen = document.getElementById('__mdf_det_screen');
    if (elB) elB.textContent = calc.blur_b.toFixed(1) + 'px';
    if (elG) elG.textContent = calc.blur_g.toFixed(1) + 'px';
    if (elScreen) elScreen.textContent = calc.screenInfo.cssW + '×' + calc.screenInfo.cssH;
  }

  function updateDot() {
    const dot = document.getElementById('__mdf_dot');
    if (dot) dot.classList.toggle('on', config.enabled);
  }

  function handleTimer() {
    config.enabled ? startTimer() : stopTimer();
  }

  /* ================================================================
   *  快捷键
   * ================================================================ */

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'D') {
      e.preventDefault();
      config.enabled = !config.enabled;
      config.enabled ? applyFilter() : removeFilter();
      updateDot();
      handleTimer();
      saveConfig();
    }
  });

  /* ================================================================
   *  油猴菜单
   * ================================================================ */

  GM_registerMenuCommand('🔄 切换滤镜开关', () => {
    config.enabled = !config.enabled;
    config.enabled ? applyFilter() : removeFilter();
    updateDot();
    handleTimer();
    saveConfig();
  });

  GM_registerMenuCommand('📊 重置计时器', resetTimer);

  /* ================================================================
   *  初始化
   * ================================================================ */

  function init() {
    // 如果未设置过 mode，自动检测
    if (!config.mode) {
      config.mode = detectMode();
      saveConfig();
    }

    injectSVGAndLayer();

    if (config.enabled) {
      applyFilter();
      startTimer();
    }

    createPanel();

    if (config.enabled) {
      const panel = document.getElementById(PANEL_ID);
      if (panel) panel.classList.remove('collapsed');
    }

    const calc = calcBlurCircles();
    console.log(
      `%c👁 近视防控离焦滤镜 v0.3.0`,
      'color:#0d9488;font-weight:bold;font-size:13px;',
      `\n  模式: ${calc.mode} (${SCENARIOS[calc.mode].label})`,
      `\n  屏幕: ${calc.screenInfo.cssW}×${calc.screenInfo.cssH} DPR=${calc.screenInfo.dpr} ≈${calc.screenInfo.estPPI}PPI`,
      `\n  LCA: 蓝=${calc.blur_b.toFixed(1)}px 绿=${calc.blur_g.toFixed(1)}px`,
      `\n  快捷键: Ctrl+Shift+D`
    );
  }

  if (document.body) {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }

})();
