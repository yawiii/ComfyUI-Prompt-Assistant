/**
 * 节点帮助文档翻译模块 (Node Help Translator)
 * 独立模块，用于检测 ComfyUI 侧边栏的节点文档翻译功能
 */

import { APIService } from "../services/api.js";
import { logger } from "../utils/logger.js";
import { UIToolkit } from "../utils/UIToolkit.js";
import { createSplitButton, createTooltip } from "./uiComponents.js";
import { PromptFormatter } from "../utils/promptFormatter.js";
import { getCurrentUiLanguage } from "../utils/uiI18n.js";

class NodeHelpTranslator {
    constructor() {
        this.observer = null;
        this.isObserving = false;
        this.stateCache = new Map();

        this.currentHelpPanel = {
            nodeName: null,
            element: null,
            bilingualSwitch: null
        };

        // 服务列表缓存（用于菜单构建）
        this._servicesCache = null;
        this._servicesCacheTime = 0;
        // 当前翻译服务配置缓存（用于菜单选中状态显示）
        this._currentTranslateConfig = null;

        // 监听全局服务变更事件，确保实时同步
        window.addEventListener('pa-service-changed', () => {
            logger.debug("[NodeHelpTranslator] 收到全局服务变更通知，正在同步配置...");
            this._getTranslateConfig();
        });
    }

    // ---翻译服务配置管理（使用全局配置）---

    /**
     * 获取当前全局翻译服务配置
     * @returns {Promise<{ serviceId: string, modelName: string } | null>}
     */
    async _getTranslateConfig() {
        try {
            const response = await fetch(APIService.getApiUrl('/config/translate'));
            if (response.ok) {
                const config = await response.json();
                this._currentTranslateConfig = config;
                return {
                    serviceId: config.provider || null,
                    modelName: config.model || null
                };
            }
        } catch (e) {
            logger.warn(`[NodeHelpTranslator] 获取翻译配置失败: ${e.message}`);
        }
        return null;
    }

    /**
     * 设置全局翻译服务配置
     * @param {string} serviceId
     * @param {string} modelName
     * @returns {Promise<boolean>}
     */
    async _setTranslateConfig(serviceId, modelName) {
        try {
            const response = await fetch(APIService.getApiUrl('/services/current'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    service_type: 'translate',
                    service_id: serviceId,
                    model_name: modelName
                })
            });
            if (response.ok) {
                const result = await response.json();
                if (result.success) {
                    logger.log(`[NodeHelpTranslator] 已更新全局翻译服务: ${serviceId} - ${modelName}`);
                    return true;
                }
            }
        } catch (e) {
            logger.warn(`[NodeHelpTranslator] 更新翻译服务失败: ${e.message}`);
        }
        return false;
    }

    /**
     * 获取可用的服务列表（带缓存）
     */
    async _getAvailableServices() {
        const now = Date.now();
        // 缓存5分钟
        if (this._servicesCache && (now - this._servicesCacheTime) < 300000) {
            return this._servicesCache;
        }

        try {
            const response = await fetch(APIService.getApiUrl('/services'));
            if (response.ok) {
                const data = await response.json();
                if (data.success && data.services) {
                    // 保存所有服务列表（百度等翻译服务可能没有 llm_models）
                    this._servicesCache = data.services;
                    this._servicesCacheTime = now;
                    return this._servicesCache;
                }
            }
        } catch (e) {
            logger.warn(`[NodeHelpTranslator] 获取服务列表失败: ${e.message}`);
        }
        return [];
    }


    initialize() {
        // 检查功能开关
        if (typeof window !== 'undefined' && window.FEATURES && !window.FEATURES.nodeHelpTranslator) {
            logger.log("[NodeHelpTranslator] 功能已禁用,跳过初始化");
            return;
        }

        if (this.isObserving) return;

        logger.log("[NodeHelpTranslator] 初始化监听器");

        this.observer = new MutationObserver((mutations) => {
            let shouldCheck = false;
            for (const mutation of mutations) {
                // 有节点增减 或 属性变更(aria-selected)
                if (mutation.type === 'childList' ||
                    (mutation.type === 'attributes' && mutation.attributeName === 'aria-selected')) {
                    shouldCheck = true;
                    break;
                }
            }
            if (shouldCheck) {
                this._checkAndInject();
            }
        });

        this.observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['aria-selected']
        });

        this._injectStyles();
        this.isObserving = true;
    }

    _injectStyles() {
        if (document.getElementById('pa-node-help-translator-styles')) return;
        const style = document.createElement('style');
        style.id = 'pa-node-help-translator-styles';
        style.textContent = `
            .pa-help-translate-btn-container {
                opacity: 0;
                animation: pa-fade-in 0.3s ease-out forwards;
                display: flex;
                align-items: center;
            }
            @keyframes pa-fade-in {
                from { opacity: 0; transform: scale(0.95); }
                to { opacity: 1; transform: scale(1); }
            }
            .pa-help-translate-btn-container.pa-fade-out {
                animation: pa-fade-out 0.2s ease-in forwards;
                pointer-events: none;
            }
            @keyframes pa-fade-out {
                from { opacity: 1; transform: scale(1); }
                to { opacity: 0; transform: scale(0.95); }
            }
            .pa-translate-btn-icon.spinning {
                animation: pa-spin 1s linear infinite;
            }
            @keyframes pa-spin {
                from { transform: rotate(0deg); }
                to { transform: rotate(360deg); }
            }
            /* ---流式输出容器样式--- */
            .pa-help-streaming-container {
                position: absolute;
                bottom: 0;
                left: 0;
                right: 0;
                max-height: 150px;
                overflow-y: auto;
                padding: 12px;
                background: linear-gradient(to top, 
                    color-mix(in srgb, var(--p-content-background), transparent 10%) 0%,
                    color-mix(in srgb, var(--p-content-background), transparent 40%) 100%);
                border-top: 1px solid var(--p-panel-border-color);
                z-index: 100;
                opacity: 0;
                transform: translateY(10px);
                transition: opacity 0.3s ease, transform 0.3s ease;
                pointer-events: none;
            }
            .pa-help-streaming-container.show {
                opacity: 1;
                transform: translateY(0);
                pointer-events: auto;
            }
            .pa-help-streaming-content {
                font-size: 13px;
                line-height: 1.6;
                color: var(--p-text-color);
                white-space: pre-wrap;
                word-break: break-word;
            }
            .pa-help-streaming-cursor {
                display: inline-block;
                width: 2px;
                height: 1em;
                background: var(--p-primary-color);
                margin-left: 2px;
                animation: pa-cursor-blink 0.8s infinite;
                vertical-align: text-bottom;
            }
            @keyframes pa-cursor-blink {
                0%, 50% { opacity: 1; }
                51%, 100% { opacity: 0; }
            }
            .pa-help-streaming-container::-webkit-scrollbar {
                width: 6px;
            }
            .pa-help-streaming-container::-webkit-scrollbar-track {
                background: transparent;
            }
            .pa-help-streaming-container::-webkit-scrollbar-thumb {
                background: color-mix(in srgb, var(--p-panel-border-color), transparent 50%);
                border-radius: 3px;
            }
            .pa-streaming-trans-text {
                display: block;
                color: var(--p-primary-color);
                font-size: 0.95em;
                line-height: 1.5;
                padding: 4px 0;
                margin-top: 4px;
                opacity: 0.9;
            }
        `;
        document.head.appendChild(style);
    }

    _handleDomChange() {
        // 该方法已被 observer 直接调用 _checkAndInject 取代，保留空函数以防其他地方引用
        this._checkAndInject();
    }

    _checkAndInject() {
        // 检查功能开关
        if (typeof window !== 'undefined' && window.FEATURES && !window.FEATURES.nodeHelpTranslator) {
            return;
        }

        if (this._injectTimer) clearTimeout(this._injectTimer);
        this._injectTimer = setTimeout(() => {
            const v3Panel = document.querySelector('[data-testid="properties-panel"]');

            if (!v3Panel) {
                // 如果找不到 V3 面板，直接清理所有可能的按钮并返回 (不再支持左侧边栏)
                this._clearAllButtons();
                return;
            }

            // --- V3 逻辑 ---
            const allTabs = Array.from(v3Panel.querySelectorAll('button[role="tab"]'));
            const activeTab = allTabs.find(t => t.getAttribute('aria-selected') === 'true');
            const activeTabText = activeTab ? activeTab.textContent.trim().toLowerCase() : '';

            // 简化识别关键字：只要包含 info 或 信息 即可
            const isInfoActive = activeTabText.includes('info') || activeTabText.includes('信息');

            // 重要：必须在当前面板内寻找帮助内容
            const helpContent = v3Panel.querySelector('.node-help-content');

            if (!isInfoActive || !helpContent) {
                this._clearAllButtons();
                return;
            }

            // 处理注入
            this._processInjection(v3Panel, helpContent);
        }, 250);
    }

    /**
     * 统一的清理函数
     */
    _clearAllButtons() {
        const strayBtns = document.querySelectorAll('.pa-help-translate-btn-container:not(.pa-fade-out)');
        if (strayBtns.length > 0) {
            strayBtns.forEach(el => {
                // 清理 tooltip（防止残留）
                const mainBtn = el.querySelector('.pa-translate-btn');
                if (mainBtn && mainBtn._paTooltip) {
                    mainBtn._paTooltip.destroy();
                    mainBtn._paTooltip = null;
                }

                el.classList.add('pa-fade-out');
                el.addEventListener('animationend', () => el.remove(), { once: true });
                // 安全兜底：如果动画没触发也强制移除
                setTimeout(() => {
                    if (el.parentNode) el.remove();
                }, 300);
            });
        }
    }

    /**
     * 核心处理逻辑：仅支持 V3 环境
     */
    _processInjection(v3Panel, helpContent) {
        if (!v3Panel) return;

        // 预加载服务列表（用于菜单显示）
        this._getAvailableServices();

        // 查找 header (注入按钮的位置)
        let header = v3Panel.querySelector('section .flex.gap-2');

        if (header) {
            const titleEl = v3Panel.querySelector('h3');
            const currentNodeName = titleEl ? titleEl.textContent.trim() : 'Unknown';

            const existingBtnContainer = header.querySelector('.pa-help-translate-btn-container');

            if (!existingBtnContainer) {
                // 所有 Info 内容都显示翻译按钮
                this._injectTranslateButton(header, currentNodeName, helpContent);
            } else {
                const btn = existingBtnContainer.querySelector('button');
                if (btn && btn.dataset.nodeName !== currentNodeName) {
                    logger.log(`[NodeHelpTranslator] 检测到节点切换: ${btn.dataset.nodeName} -> ${currentNodeName}，重置按钮状态`);
                    this._resetButtonState(btn, currentNodeName);
                }
            }
        }
    }

    _injectTranslateButton(header, nodeName, helpContent) {
        if (!header) return;
        if (header.querySelector('.pa-help-translate-btn-container')) return;

        const btnContainer = document.createElement('div');
        btnContainer.className = 'pa-help-translate-btn-container';

        const splitBtn = createSplitButton({
            label: "翻译文档",
            icon: "pi pi-language",
            className: "p-splitbutton-compact p-splitbutton-primary",
            align: "right",
            onClick: (e) => {
                const btn = splitBtn.container.querySelector('.p-button:first-child');
                this._handleTranslateClick(e, btn);
            },
            // 使用函数式动态项，每次打开下拉框时实时获取最新状态
            // 不再传递硬编码的 'bilingual'，由 _getMenuItems 内部动态决定
            items: () => this._getMenuItems(nodeName)
        });

        const mainBtn = splitBtn.container.querySelector('.p-button:first-child');
        mainBtn.classList.add('pa-translate-btn');
        mainBtn.dataset.nodeName = nodeName;
        mainBtn.dataset.targetLang = this._defaultTargetLang(); // RU-FORK: ru-локаль -> по умолчанию русский
        mainBtn._paSplitBtn = splitBtn;
        this.currentHelpPanel.splitBtn = splitBtn;

        this._setButtonContent(mainBtn, 'translate');

        btnContainer.appendChild(splitBtn.container);

        // 尝试将其插入到“关闭面板”按钮之前
        const toggleBtn = header.querySelector('[aria-label*="panel"], [aria-label*="Panel"]');
        if (toggleBtn) {
            header.insertBefore(btnContainer, toggleBtn);
        } else {
            header.appendChild(btnContainer);
        }

        logger.log(`[NodeHelpTranslator] 已注入翻译按钮(SplitBtn)到节点: ${nodeName}`);

        if (helpContent) {
            this._restoreFromCache(mainBtn, helpContent, nodeName);
        }
    }

    /**
     * RU-FORK: язык по умолчанию для перевода справки узлов —
     * при русской локали интерфейса это русский, иначе прежний 'zh'.
     */
    _defaultTargetLang() {
        try {
            if (getCurrentUiLanguage() === 'ru') return 'ru';
        } catch { }
        return 'zh';
    }

    _resetButtonState(btn, newNodeName) {
        btn.dataset.nodeName = newNodeName;
        btn.dataset.targetLang = this._defaultTargetLang(); // RU-FORK: ru-локаль -> по умолчанию русский
        this._setButtonContent(btn, 'translate');
        btn.disabled = false;
        if (btn._paSplitBtn) {
            btn._paSplitBtn.updateMenu(this._getMenuItems(newNodeName, 'bilingual'));
        }

        const v3Panel = btn.closest('[data-testid="properties-panel"]');
        const helpContent = v3Panel ? v3Panel.querySelector('.node-help-content') : null;
        if (helpContent) {
            this._restoreFromCache(btn, helpContent, newNodeName);
        }
    }

    _setButtonContent(btn, type) {
        let label = '翻译';
        let iconClass = 'pi pi-language pa-translate-btn-icon';
        let spinning = false;
        let tooltip = '';

        switch (type) {
            case 'translate':
                label = '翻译';
                iconClass = 'pi pi-language pa-translate-btn-icon';
                tooltip = '使用✨提示词小助手翻译文档';
                break;
            case 'translating':
                label = '翻译中...';
                iconClass = 'pi pi-spinner pa-translate-btn-icon';
                spinning = true;
                tooltip = '正在翻译文档...';
                break;
            case 'translated':
                label = '已翻译';
                iconClass = 'pi pi-check pa-translate-btn-icon';
                tooltip = '点击重新翻译';
                break;
        }

        if (btn._paSplitBtn) {
            btn._paSplitBtn.updateMainButton(label, iconClass, spinning);
        } else {
            btn.innerHTML = `
                <span class="p-button-icon p-button-icon-left ${iconClass} pa-translate-btn-icon ${spinning ? 'spinning' : ''}"></span>
                <span class="p-button-label">${label}</span>
            `;
        }

        // 更新自定义 Tooltip
        if (btn._paTooltip) {
            btn._paTooltip.destroy();
            btn._paTooltip = null;
        }

        if (tooltip) {
            btn._paTooltip = createTooltip({
                target: btn,
                content: tooltip,
                position: 'top'
            });
        }
    }

    async _handleTranslateClick(e, btn) {
        e.stopPropagation();

        const nodeName = btn.dataset.nodeName;
        const targetLang = btn.dataset.targetLang || 'zh';
        // RU-FORK: node help документация по умолчанию на английском/китайском;
        // для русского целью ставим ru, источником — en (docs на английском)
        const from = targetLang === 'zh' ? 'en' : (targetLang === 'ru' ? 'en' : 'zh');
        const to = targetLang;

        // 寻找内容容器的增强逻辑 (与 _handleModeChange 保持一致)
        let contentEl = null;

        // 策略1: 如果按钮就在 properties-panel 中 (V3)
        const v3Panel = btn.closest('[data-testid="properties-panel"]');
        if (v3Panel) {
            contentEl = v3Panel.querySelector('.node-help-content');
        }

        // 策略2: 回退到旧版层级查找
        if (!contentEl) {
            const header = btn.closest('.border-b') || btn.closest('.pa-help-translate-btn-container').parentElement;
            if (header) {
                const container = header.parentElement;
                contentEl = container.querySelector('.node-help-content');
            }
        }

        if (!contentEl) {
            UIToolkit.showStatusTip(btn, 'warn', '未找到帮助内容');
            return;
        }

        // 允许重新翻译
        await this._performTranslation(btn, contentEl, nodeName, from, to);
    }

    async _performTranslation(btn, contentEl, nodeName, from = 'en', to = 'zh') {
        this._setButtonContent(btn, 'translating');
        btn.disabled = true;

        // 用于错误处理时清理流式状态
        let textBlocks = [];

        try {
            // 重置之前的翻译状态（如果有）
            // 如果已经翻译过，先还原DOM，以便重新提取文本
            const existingTranslatable = contentEl.querySelectorAll('.pa-translatable');
            if (existingTranslatable.length > 0) {
                existingTranslatable.forEach(el => {
                    if (el.dataset.paOriginal) {
                        el.innerHTML = el.dataset.paOriginal;
                    }
                    el.classList.remove('pa-translatable');
                    delete el.dataset.paTranslation;
                    // dataset.paOriginal 保留或删除皆可，保留着也没事，extractTextBlocks 不会利用它，而是读 innerText
                    // 但是为了干净，还是清理一下
                    delete el.dataset.paOriginal;
                });
            }

            contentEl.classList.remove('pa-mode-bilingual', 'pa-mode-translation-only', 'pa-mode-original-only');

            textBlocks = this._extractTextBlocks(contentEl);
            if (textBlocks.length === 0) {
                UIToolkit.showStatusTip(btn, 'warn', '没有找到可翻译的内容');
                this._setButtonContent(btn, 'translate'); // 恢复为待翻译状态
                return;
            }
            // ... remainder is unchanged logic, but extractTextBlocks comes next


            const textsToTranslate = textBlocks.map(block => block.text);
            let translations = [];
            let isBaidu = false;

            // 1. 获取全局翻译配置
            // 直接使用后端全局配置（与 PromptAssistant 共享）
            try {
                const configResp = await fetch(APIService.getApiUrl('/config/translate'));
                if (configResp.ok) {
                    const config = await configResp.json();
                    if (config.provider === 'baidu') {
                        isBaidu = true;
                    }
                }
            } catch (e) {
                logger.warn(`[NodeHelpTranslator] 获取翻译配置失败: ${e.message}，将默认使用LLM`);
            }

            // 2. 根据服务类型执行翻译
            if (isBaidu) {
                logger.log(`[NodeHelpTranslator] 使用百度翻译API进行翻译 (${from}->${to})`);
                // 百度批量翻译是串行请求，返回结果数组
                const results = await APIService.batchBaiduTranslate(textsToTranslate, from, to);

                // 提取翻译结果，BaiduTranslateService 返回格式需与 LLM 保持一致 (data.translated)
                // 如果某个请求失败，result.success 为 false，这里暂时填 null 跳过
                translations = results.map(r => {
                    if (r && r.success && r.data && r.data.translated) {
                        return r.data.translated;
                    }
                    return null;
                });

                // 检查是否所有翻译都失败了
                const successCount = translations.filter(t => t !== null).length;
                if (successCount === 0 && textsToTranslate.length > 0) {
                    throw new Error('所有文本翻译失败 (Baidu)');
                }

            } else {
                // ---使用LLM翻译---
                const textCount = textsToTranslate.length;
                const enableStreaming = typeof window !== 'undefined' &&
                    window.FEATURES && window.FEATURES.enableStreaming !== false;

                if (enableStreaming) {
                    // ---LLM单请求批量流式翻译---
                    logger.log(`[NodeHelpTranslator] 使用LLM批量流式翻译 (${from}->${to}) | 文本数:${textCount}`);

                    const totalBlocks = textsToTranslate.length;

                    // 1. 先为所有文本块创建流式显示区域
                    textBlocks.forEach((block, i) => {
                        const el = block.element;
                        if (!el.dataset.paOriginal) {
                            el.dataset.paOriginal = el.innerHTML;
                        }
                        el.classList.add('pa-translatable');

                        const wrappedOriginal = `<span class="pa-original-content">${el.dataset.paOriginal}</span>`;
                        const separator = `<span class="pa-trans-separator"></span>`;
                        const streamingArea = `<span class="pa-streaming-trans-text" data-block-index="${i}"></span>`;
                        el.innerHTML = `${wrappedOriginal}${separator}${streamingArea}`;
                    });

                    // 2. 构建带编号的批量翻译请求文本
                    // 格式：[1] 原文1\n[2] 原文2\n...
                    const numberedText = textsToTranslate
                        .map((text, i) => `[${i + 1}] ${text}`)
                        .join('\n\n');

                    // 3. 流式解析状态
                    let fullContent = '';
                    let currentBlockIndex = -1;
                    let blockTranslations = new Array(totalBlocks).fill('');

                    // 4. 发起单次流式翻译请求（使用全局配置）
                    const result = await this._llmTranslateStreamWithConfig(
                        numberedText,
                        from,
                        to,
                        null,  // 使用全局配置，不需要传递独立参数
                        (chunk) => {
                            fullContent += chunk;

                            // 解析流式内容，识别编号并更新对应DOM
                            this._parseAndUpdateStreamingContent(
                                fullContent,
                                textBlocks,
                                blockTranslations
                            );

                            // 更新进度
                            const completedCount = blockTranslations.filter(t => t.length > 0).length;
                            const percent = Math.round((completedCount / totalBlocks) * 100);
                            if (btn._paSplitBtn) {
                                btn._paSplitBtn.updateMainButton(`${percent}%`, 'pi pi-spinner pa-translate-btn-icon', true);
                            }
                        }
                    );

                    // 5. 最终解析确保所有内容都被处理
                    this._parseAndUpdateStreamingContent(fullContent, textBlocks, blockTranslations, true);

                    // 6. 收集翻译结果并更新为最终样式
                    textBlocks.forEach((block, i) => {
                        const el = block.element;
                        const translation = blockTranslations[i]?.trim();

                        if (translation) {
                            translations.push(translation);
                            el.dataset.paTranslation = translation;
                            // 切换为正式的翻译样式
                            const wrappedOriginal = `<span class="pa-original-content">${el.dataset.paOriginal}</span>`;
                            const separator = `<span class="pa-trans-separator"></span>`;
                            const styledTranslation = `<span class="pa-trans-text">${translation.replace(/\n/g, '<br>')}</span>`;
                            el.innerHTML = `${wrappedOriginal}${separator}${styledTranslation}`;
                        } else {
                            translations.push(null);
                            logger.warn(`[NodeHelpTranslator] 第${i + 1}个文本块翻译失败`);
                            el.innerHTML = el.dataset.paOriginal;
                            el.classList.remove('pa-translatable');
                        }
                    });

                    // 检查翻译成功率
                    const successCount = translations.filter(t => t !== null).length;
                    if (successCount === 0 && textsToTranslate.length > 0) {
                        throw new Error('所有文本翻译失败 (LLM Stream)');
                    }

                } else if (textCount <= 5) {
                    // 文本较少时，直接使用单次批量翻译
                    logger.log(`[NodeHelpTranslator] 使用LLM单次批量翻译 (${from}->${to}) | 文本数:${textCount}`);
                    const result = await APIService.llmBatchTranslate(textsToTranslate, from, to);

                    if (result.success && result.data && result.data.translations) {
                        translations = result.data.translations;
                    } else {
                        throw new Error(result.error || '翻译接口返回错误');
                    }
                } else {
                    // 文本较多时，使用并行分块翻译
                    logger.log(`[NodeHelpTranslator] 使用LLM并行分块翻译 (${from}->${to}) | 文本数:${textCount}`);
                    const result = await APIService.llmParallelBatchTranslate(textsToTranslate, from, to, {
                        chunkSize: 5,
                        concurrency: 3,
                        onProgress: (completed, total) => {
                            const percent = Math.round((completed / total) * 100);
                            if (btn._paSplitBtn) {
                                btn._paSplitBtn.updateMainButton(`${percent}%`, 'pi pi-spinner pa-translate-btn-icon', true);
                            }
                        }
                    });

                    if (result.success && result.data && result.data.translations) {
                        translations = result.data.translations;
                    } else {
                        throw new Error(result.error || '并行翻译失败');
                    }
                }
            }

            // 3. 流式模式下不需要再渲染（已在循环中完成），非流式需要渲染
            const enableStreaming = typeof window !== 'undefined' &&
                window.FEATURES && window.FEATURES.enableStreaming !== false;

            if (!enableStreaming || isBaidu) {
                // 非流式模式或百度翻译：批量渲染结果
                const cleanedTranslations = translations.map(t => t ? t.replace(/^\|\s*/, '') : t);
                this._renderTranslations(textBlocks, cleanedTranslations, nodeName);
            } else {
                // 流式模式：清理结果并保存缓存
                const cleanedTranslations = translations.map(t => t ? t.replace(/^\|\s*/, '') : t);
                // 更新 dataset 中的翻译结果（用于缓存和模式切换）
                textBlocks.forEach((block, index) => {
                    const translation = cleanedTranslations[index];
                    if (translation) {
                        block.element.dataset.paTranslation = translation;
                    }
                });
                // 保存缓存
                const cacheData = cleanedTranslations.map((t, i) => ({ index: i, translation: t })).filter(item => item.translation);
                this._saveToCache(nodeName, {
                    translations: cacheData,
                    timestamp: Date.now(),
                    bilingual: true
                });
            }

            this.stateCache.set(nodeName, { translated: true, viewMode: 'bilingual' });

            if (this.currentHelpPanel.splitBtn) {
                this.currentHelpPanel.splitBtn.updateMenu(this._getMenuItems(nodeName, 'bilingual'));
            }

            this._setButtonContent(btn, 'translated');

        } catch (error) {
            logger.error(`[NodeHelpTranslator] 翻译失败: ${error.message}`);
            UIToolkit.showStatusTip(btn, 'error', '翻译失败: ' + error.message);
            this._setButtonContent(btn, 'translate');
            btn.disabled = false;

            // 清理流式状态
            textBlocks?.forEach(block => {
                const el = block.element;
                if (el.dataset.paOriginal && !el.dataset.paTranslation) {
                    el.innerHTML = el.dataset.paOriginal;
                    el.classList.remove('pa-translatable');
                }
            });
        } finally {
            btn.disabled = false;
        }
    }

    /**
     * 带可选服务/模型配置的流式翻译
     * @param {string} text - 要翻译的文本
     * @param {string} fromLang - 源语言
     * @param {string} toLang - 目标语言
     * @param {Object|null} config - 可选配置 { serviceId, modelName }
     * @param {Function} onChunk - 接收每个 chunk 的回调函数
     */
    async _llmTranslateStreamWithConfig(text, fromLang, toLang, config, onChunk) {
        try {
            if (!text || text.trim() === '') {
                throw new Error('请输入要翻译的内容');
            }

            const request_id = APIService.generateRequestId('trans');
            const apiUrl = APIService.getApiUrl('llm/translate/stream');

            // 构建请求体，添加可选的服务/模型参数
            const body = {
                text,
                from: fromLang,
                to: toLang,
                request_id
            };

            // 如果有独立配置，添加服务和模型参数
            if (config && config.serviceId && config.modelName) {
                body.service_id = config.serviceId;
                body.model_name = config.modelName;
                logger.debug(`[NodeHelpTranslator] 流式翻译使用指定服务: ${config.serviceId} - ${config.modelName}`);
            }

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let finalResult = null;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            if (data.chunk && onChunk) {
                                onChunk(data.chunk);
                            }
                            if (data.done) {
                                finalResult = data.result;
                            }
                            if (data.error) {
                                throw new Error(data.error);
                            }
                        } catch (parseError) {
                            if (parseError.message !== 'Unexpected end of JSON input') {
                                logger.warn(`解析 SSE 数据失败: ${parseError.message}`);
                            }
                        }
                    }
                }
            }

            return finalResult;

        } catch (error) {
            logger.error(`[NodeHelpTranslator] 流式翻译失败: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    /**
     * 解析流式翻译内容并更新对应的DOM元素
     * @param {string} content - 累积的流式内容
     * @param {Array} textBlocks - 文本块数组
     * @param {Array} blockTranslations - 各块翻译结果数组
     * @param {boolean} isFinal - 是否为最终解析
     */
    _parseAndUpdateStreamingContent(content, textBlocks, blockTranslations, isFinal = false) {
        if (!content) return;

        // 使用正则解析带编号的翻译内容
        // 格式：[1] 翻译内容1\n[2] 翻译内容2\n...
        // 或者：[1]翻译内容1[2]翻译内容2...（无换行）
        const blockPattern = /\[(\d+)\]\s*/g;
        const matches = [...content.matchAll(blockPattern)];

        if (matches.length === 0) {
            // 没有找到编号，可能还在输出第一个块的内容
            // 尝试更新第一个块
            if (textBlocks.length > 0) {
                const streamingEl = textBlocks[0].element.querySelector('.pa-streaming-trans-text');
                if (streamingEl) {
                    streamingEl.textContent = content.trim();
                }
                blockTranslations[0] = content.trim();
            }
            return;
        }

        // 解析每个块的内容
        for (let i = 0; i < matches.length; i++) {
            const match = matches[i];
            const blockNum = parseInt(match[1], 10);
            const blockIndex = blockNum - 1; // 转为0-indexed

            if (blockIndex < 0 || blockIndex >= textBlocks.length) continue;

            // 计算该块内容的起止位置
            const startPos = match.index + match[0].length;
            const endPos = (i + 1 < matches.length) ? matches[i + 1].index : content.length;

            // 提取该块的翻译内容
            const blockContent = content.substring(startPos, endPos).trim();

            // 更新翻译数组
            blockTranslations[blockIndex] = blockContent;

            // 更新DOM显示
            const streamingEl = textBlocks[blockIndex].element.querySelector('.pa-streaming-trans-text');
            if (streamingEl) {
                streamingEl.textContent = blockContent;
            }
        }
    }

    /**
     * 提取文本块
     */
    _extractTextBlocks(rootEl) {
        const blocks = [];
        // 优化1：不提取 th (表头)，因为无需翻译
        const candidates = rootEl.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, td');

        for (const el of candidates) {
            const text = el.innerText.trim();
            if (!text) continue;

            // 过滤纯数字和标点
            if (/^[0-9\s\p{P}]+$/u.test(text)) continue;

            // 优化2：过滤看似“类型”定义的纯大写单词 (如 IMAGE, FLOAT, BOOLEAN, COMBO等)
            // 允许特定符号如下划线，但不包含空格（通常类型是一个单词）
            // 限制长度<30，防止误伤全大写的长句子
            // 注意：参数名通常是 snake_case (小写)，所以不会被过滤
            if (/^[A-Z0-9_]+$/.test(text) && text.length < 30) continue;

            if (el.closest('pre') || el.closest('code')) continue;
            if (el.classList.contains('pa-translatable')) continue;
            if (el.closest('.pa-translatable')) continue;

            const hasBlockChildren = Array.from(el.children).some(child =>
                ['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'UL', 'OL'].includes(child.tagName)
            );
            if (hasBlockChildren) continue;

            blocks.push({ element: el, text: text });
        }

        return blocks;
    }

    _renderTranslations(blocks, translations, nodeName) {
        // 保存用于缓存的数据
        const cacheData = [];

        blocks.forEach((block, index) => {
            const translation = translations[index];
            if (!translation) return;

            const el = block.element;
            el.classList.add('pa-translatable');

            if (!el.dataset.paOriginal) {
                el.dataset.paOriginal = el.innerHTML;
            }
            el.dataset.paTranslation = translation;

            this._updateBlockContent(el, 'bilingual');

            // 收集缓存数据（存储原始HTML的哈希或简单选择器作为标识可能不可靠，因为DOM结构变化）
            // 这里我们使用一种简单策略：按顺序存储。
            // 只要帮助文档内容没变，顺序提取的文本块也应该没变。
            cacheData.push({
                index: index, // 保存索引，以便恢复时匹配
                translation: translation
            });
        });

        // 保存到缓存
        if (nodeName) {
            this._saveToCache(nodeName, {
                translations: cacheData,
                timestamp: Date.now(),
                bilingual: true
            });
        }
    }

    _updateBlockContent(el, mode) {
        const original = el.dataset.paOriginal || '';
        const translation = el.dataset.paTranslation || '';

        // Wrap original content to allow toggling visibility
        const wrappedOriginal = `<span class="pa-original-content">${original}</span>`;
        const separator = `<span class="pa-trans-separator"></span>`;
        const styledTranslation = `<span class="pa-trans-text">${translation.replace(/\n/g, '<br>')}</span>`;

        el.innerHTML = `${wrappedOriginal}${separator}${styledTranslation}`;
    }

    // --- 缓存管理 ---

    _getCacheKey() {
        return 'pa_node_help_translations';
    }

    _loadFromCache(nodeName) {
        try {
            const raw = sessionStorage.getItem(this._getCacheKey());
            if (!raw) return null;
            const cache = JSON.parse(raw);
            return cache[nodeName] || null;
        } catch (e) {
            console.error('[NodeHelpTranslator] 读取缓存失败', e);
            return null;
        }
    }

    _saveToCache(nodeName, data) {
        try {
            const key = this._getCacheKey();
            const raw = sessionStorage.getItem(key);
            let cache = raw ? JSON.parse(raw) : {};

            cache[nodeName] = data;

            // 简单的清理策略：如果太大了，清空旧的（虽然sessionStorage限制是按域名，但也要防止无限增长）
            // 这里暂不实现复杂LRU，假设用户单次会话查看的节点有限

            sessionStorage.setItem(key, JSON.stringify(cache));
        } catch (e) {
            console.error('[NodeHelpTranslator] 写入缓存失败', e);
        }
    }

    _restoreFromCache(btn, contentEl, nodeName) {
        const cached = this._loadFromCache(nodeName);
        if (!cached) return false;

        // 检查是否过期（例如超过24小时？其实sessionStorage已经限制了会话生命周期，这里可以不检查时间）
        // 但检查是否匹配当前内容结构很重要。
        // 我们尝试按索引恢复。

        const textBlocks = this._extractTextBlocks(contentEl);
        if (textBlocks.length === 0) return false;

        // 简单的完整性检查：如果缓存的索引超出了当前文本块数量，可能内容变了
        const maxIndex = Math.max(...cached.translations.map(t => t.index));
        if (maxIndex >= textBlocks.length) {
            logger.warn(`[NodeHelpTranslator] 缓存与当前内容不匹配(索引溢出)，跳过恢复: ${nodeName}`);
            return false;
        }

        // 恢复翻译
        // 构建全量的 translations 数组
        // cached.translations 是稀疏的，只包含有翻译的块
        const appliedTranslations = new Array(textBlocks.length).fill(null);
        let matchCount = 0;

        cached.translations.forEach(item => {
            if (item.index < textBlocks.length) {
                // 可选：对比一下原文内容是否大致匹配？（防止内容微调导致错位）
                // 这里为了性能暂不对比原文，严格依赖提取顺序
                appliedTranslations[item.index] = item.translation;
                matchCount++;
            }
        });

        if (matchCount === 0) return false;

        // 渲染
        this._renderTranslations(textBlocks, appliedTranslations, null); // passing null as nodeName to avoid recursive save

        // 恢复状态
        const viewMode = cached.viewMode || (cached.bilingual !== false ? 'bilingual' : 'translation-only');
        this.stateCache.set(nodeName, { translated: true, viewMode: viewMode });

        // 更新按钮状态
        this._setButtonContent(btn, 'translated');

        // 更新 SplitButton 菜单
        if (btn._paSplitBtn) {
            btn._paSplitBtn.updateMenu(this._getMenuItems(nodeName, viewMode));
        }

        // 应用显示模式
        this._applyViewMode(contentEl, viewMode);

        logger.log(`[NodeHelpTranslator] 已从缓存恢复翻译: ${nodeName}`);
        return true;
    }

    cleanup() {
        // 清理定时器
        if (this._injectTimer) {
            clearTimeout(this._injectTimer);
            this._injectTimer = null;
        }

        // 停止并清理 MutationObserver
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
        this.isObserving = false;

        // 移除所有已注入的翻译按钮
        const translationButtons = document.querySelectorAll('.pa-help-translate-btn-container');
        translationButtons.forEach(btn => {
            // 清理 tooltip
            const mainBtn = btn.querySelector('.pa-translate-btn');
            if (mainBtn && mainBtn._paTooltip) {
                mainBtn._paTooltip.destroy();
                mainBtn._paTooltip = null;
            }
            // 移除按钮容器
            btn.remove();
        });

        // 清理状态缓存
        this.stateCache.clear();

        // 重置当前帮助面板引用
        this.currentHelpPanel = {
            nodeName: null,
            element: null,
            bilingualSwitch: null
        };

        logger.log("[NodeHelpTranslator] 已清理所有资源");
    }

    /**
     * 应用视图模式
     * @param {HTMLElement} contentEl 内容元素
     * @param {string} mode 'bilingual' | 'translation-only' | 'original-only'
     */
    _applyViewMode(contentEl, mode) {
        if (!contentEl) return;
        contentEl.classList.remove('pa-mode-bilingual', 'pa-mode-translation-only', 'pa-mode-original-only');

        switch (mode) {
            case 'bilingual':
                contentEl.classList.add('pa-mode-bilingual');
                break;
            case 'translation-only':
                contentEl.classList.add('pa-mode-translation-only');
                break;
            case 'original-only':
                contentEl.classList.add('pa-mode-original-only');
                break;
        }
    }

    /**
     * 获取下拉菜单配置
     * @param {string} nodeName
     * @param {string} currentMode
     * @returns {Array}
     */
    _getMenuItems(nodeName, currentMode) {
        // 如果未显式传递模式，则从状态缓存中实时获取（解决动态菜单打开时的状态同步问题）
        if (!currentMode) {
            currentMode = this.stateCache.get(nodeName)?.viewMode || 'bilingual';
        }

        const btn = document.querySelector(`.pa-translate-btn[data-node-name="${nodeName}"]`);
        const targetLang = btn ? (btn.dataset.targetLang || 'zh') : 'zh';

        // 异步获取最新配置（确保下次打开或后台更新时数据正确）
        this._getTranslateConfig();

        // 立即使用的配置
        const cachedConfig = this._currentTranslateConfig;
        const currentServiceId = cachedConfig?.provider || null;
        const currentModelName = cachedConfig?.model || null;

        // 构建服务选择子菜单
        const serviceMenuItems = this._buildServiceMenuItems(nodeName, currentMode, currentServiceId, currentModelName);

        return [
            {
                label: '翻译成中文',
                icon: targetLang === 'zh' ? 'pi pi-check' : '',
                className: targetLang === 'zh' ? 'pa-menu-item-active' : '',
                command: () => {
                    const b = document.querySelector(`.pa-translate-btn[data-node-name="${nodeName}"]`);
                    if (b) {
                        b.dataset.targetLang = 'zh';
                        if (this.currentHelpPanel.splitBtn) {
                            this.currentHelpPanel.splitBtn.updateMenu(this._getMenuItems(nodeName, currentMode));
                        }
                    }
                }
            },
            {
                label: '翻译成英文',
                icon: targetLang === 'en' ? 'pi pi-check' : '',
                className: targetLang === 'en' ? 'pa-menu-item-active' : '',
                command: () => {
                    const b = document.querySelector(`.pa-translate-btn[data-node-name="${nodeName}"]`);
                    if (b) {
                        b.dataset.targetLang = 'en';
                        if (this.currentHelpPanel.splitBtn) {
                            this.currentHelpPanel.splitBtn.updateMenu(this._getMenuItems(nodeName, currentMode));
                        }
                    }
                }
            },
            {
                // RU-FORK: перевод справки узлов на русский
                label: '翻译成俄语',
                icon: targetLang === 'ru' ? 'pi pi-check' : '',
                className: targetLang === 'ru' ? 'pa-menu-item-active' : '',
                command: () => {
                    const b = document.querySelector(`.pa-translate-btn[data-node-name="${nodeName}"]`);
                    if (b) {
                        b.dataset.targetLang = 'ru';
                        if (this.currentHelpPanel.splitBtn) {
                            this.currentHelpPanel.splitBtn.updateMenu(this._getMenuItems(nodeName, currentMode));
                        }
                    }
                }
            },
            { separator: true },
            {
                label: '中英对照',
                checked: currentMode === 'bilingual',
                command: () => this._handleModeChange(nodeName, 'bilingual')
            },
            {
                label: '显示译文',
                checked: currentMode === 'translation-only',
                command: () => this._handleModeChange(nodeName, 'translation-only')
            },
            {
                label: '显示原文',
                checked: currentMode === 'original-only',
                command: () => this._handleModeChange(nodeName, 'original-only')
            },
            { separator: true },
            {
                label: '选择服务',
                icon: 'pi pi-server',
                items: serviceMenuItems
            },
            { separator: true },
            {
                label: '重新翻译',
                icon: 'pi pi-refresh',
                command: () => {
                    const b = document.querySelector(`.pa-translate-btn[data-node-name="${nodeName}"]`);
                    if (b) this._handleTranslateClick(new CustomEvent('re-translate'), b);
                }
            }
        ];
    }

    /**
     * 构建服务选择子菜单
     */
    _buildServiceMenuItems(nodeName, currentMode, currentServiceId, currentModelName) {
        const services = this._servicesCache || [];

        if (services.length === 0 && !this._servicesCache) {
            // 异步加载服务列表，加载完成后刷新菜单
            this._getAvailableServices().then(() => {
                if (this.currentHelpPanel.splitBtn) {
                    this.currentHelpPanel.splitBtn.updateMenu(this._getMenuItems(nodeName, currentMode));
                }
            });
            return [{ label: '加载中...', disabled: true }];
        }

        const menuItems = [];

        // 1. 添加百度翻译选项（始终显示）
        const isBaidu = currentServiceId === 'baidu';
        menuItems.push({
            label: '百度翻译',
            icon: isBaidu ? 'pi pi-check' : '',
            command: async () => {
                const success = await this._setTranslateConfig('baidu', '');
                if (success) {
                    // 立即更新本地缓存，实现实时同步
                    this._currentTranslateConfig = { provider: 'baidu', model: '' };

                    UIToolkit.showStatusTip(
                        document.querySelector(`.pa-translate-btn[data-node-name="${nodeName}"]`),
                        'success',
                        '已选择: 百度翻译'
                    );
                    if (this.currentHelpPanel.splitBtn) {
                        this.currentHelpPanel.splitBtn.updateMenu(this._getMenuItems(nodeName, currentMode));
                    }

                    // 广播全局服务变更事件，通知其他组件同步
                    window.dispatchEvent(new CustomEvent('pa-service-changed', {
                        detail: { service_type: 'translate', service_id: 'baidu' }
                    }));
                }
            }
        });

        menuItems.push({ separator: true });

        // 2. 为每个 LLM 服务创建菜单项
        services.filter(s => s.llm_models && s.llm_models.length > 0).forEach(service => {
            const isCurrentService = currentServiceId === service.id;
            const models = service.llm_models || [];

            if (models.length === 0) return;

            // 创建模型子菜单
            const modelItems = models.map(model => {
                const isCurrentModel = isCurrentService && currentModelName === model.name;
                return {
                    label: model.display_name || model.name,
                    icon: isCurrentModel ? 'pi pi-check' : '',
                    command: async () => {
                        const success = await this._setTranslateConfig(service.id, model.name);
                        if (success) {
                            // 立即更新本地缓存，实现实时同步
                            this._currentTranslateConfig = { provider: service.id, model: model.name };

                            const modelLabel = model.display_name || model.name;
                            UIToolkit.showStatusTip(
                                document.querySelector(`.pa-translate-btn[data-node-name="${nodeName}"]`),
                                'success',
                                `已选择: ${service.name} - ${modelLabel}`
                            );
                            if (this.currentHelpPanel.splitBtn) {
                                this.currentHelpPanel.splitBtn.updateMenu(this._getMenuItems(nodeName, currentMode));
                            }

                            // 广播全局服务变更事件，通知其他组件同步
                            window.dispatchEvent(new CustomEvent('pa-service-changed', {
                                detail: { service_type: 'translate', service_id: service.id, model_name: model.name }
                            }));
                        }
                    }
                };
            });

            menuItems.push({
                label: service.name || service.id,
                icon: isCurrentService ? 'pi pi-check-circle' : '',
                items: modelItems
            });
        });

        return menuItems;
    }

    async _handleModeChange(nodeName, mode) {
        const state = this.stateCache.get(nodeName);
        if (!state) return;

        state.viewMode = mode;
        this.stateCache.set(nodeName, state);

        const btn = document.querySelector(`.pa-translate-btn[data-node-name="${nodeName}"]`);
        if (!btn) return;

        // 寻找内容容器的增强逻辑
        // Find header then panel then content
        let contentEl = null;

        // 按钮就在 properties-panel 中 (V3)
        const v3Panel = btn.closest('[data-testid="properties-panel"]');
        if (v3Panel) {
            contentEl = v3Panel.querySelector('.node-help-content');
        }

        if (contentEl) {
            this._applyViewMode(contentEl, mode);
        }

        const cachedData = this._loadFromCache(nodeName);
        if (cachedData) {
            this._saveToCache(nodeName, { ...cachedData, viewMode: mode });
        }

        if (this.currentHelpPanel.splitBtn) {
            this.currentHelpPanel.splitBtn.updateMenu(this._getMenuItems(nodeName, mode));
        }
    }
}

export const nodeHelpTranslator = new NodeHelpTranslator();
