/**
 * 提示词小助手核心类
 * 统一管理小助手的生命周期、实例创建、UI交互等功能
 */

import { app } from "../../../../scripts/app.js";
import { logger } from '../utils/logger.js';
import { FEATURES } from "../services/features.js";
import { HistoryManager } from "./history.js";
import { TagManager } from "./tag.js";
import { HistoryCacheService, TagCacheService, TranslateCacheService, CACHE_CONFIG, CacheService } from "../services/cache.js";
import { EventManager } from "../utils/eventManager.js";
import { ResourceManager } from "../utils/resourceManager.js";
import { UIToolkit } from "../utils/UIToolkit.js";
import { PromptFormatter } from "../utils/promptFormatter.js";
import { tUI } from "../utils/uiI18n.js"; // RU-FORK: локализация статус-сообщений
import { APIService } from "../services/api.js";

import { buttonMenu } from "../services/btnMenu.js";
import { rulesConfigManager } from "./rulesConfigManager.js";
import { nodeMountService, RENDER_MODE } from "../services/NodeMountService.js";
import { AssistantContainer, ANCHOR_POSITION } from "./AssistantContainer.js";
import { PopupManager } from "../utils/popupManager.js";
import { MarkdownNoteTranslate } from "../utils/markdownNoteTranslate.js";



// ====================== 工具函数 ======================

/**
 * 计算小助手UI的预设宽度
 * 根据当前启用的功能数量返回对应的固定宽度值
 * @returns {number} 宽度值（像素）
 */
function calculateAssistantWidth() {
    // 统计启用的功能
    const hasHistory = window.FEATURES.history;
    const hasTag = window.FEATURES.tag;
    const hasExpand = window.FEATURES.expand;
    const hasTranslate = window.FEATURES.translate;

    // 统计非历史功能的数量
    const otherFeaturesCount = [hasTag, hasExpand, hasTranslate].filter(Boolean).length;

    // 根据功能组合返回预设常量宽度
    if (hasHistory && otherFeaturesCount === 3) {
        return 143; // 所有功能全开 (历史3 + 分隔线1 + 其它3)
    } else if (hasHistory && otherFeaturesCount === 2) {
        return 121; // 历史 + 两个其它
    } else if (hasHistory && otherFeaturesCount === 1) {
        return 99;  // 历史 + 一个其它
    } else if (hasHistory && otherFeaturesCount === 0) {
        return 77;  // 只有历史功能
    } else if (!hasHistory && otherFeaturesCount === 3) {
        return 72;  // 关闭历史的三个功能
    } else if (!hasHistory && otherFeaturesCount === 2) {
        return 50;  // 只有两个按钮
    } else if (!hasHistory && otherFeaturesCount === 1) {
        return 28;  // 只有一个按钮
    }

    return 28; // 默认
}



/**
 * 防抖函数
 * 限制函数调用频率，避免频繁触发导致性能问题
 */
function debounce(func, wait = 100) {
    return EventManager.debounce(func, wait);
}

/**
 * 获取输入元素的内容
 * 支持普通textarea、Tiptap编辑器、ProseMirror编辑器等
 * @param {object} widget - 小助手widget对象
 * @returns {string} 输入内容
 */
function getInputValue(widget, options = {}) {
    if (!widget || !widget.inputEl) {
        return '';
    }

    const inputEl = widget.inputEl;
    const returnHtml = options.html === true;

    // 标准textarea
    if (inputEl.tagName === 'TEXTAREA' && inputEl.value !== undefined) {
        return inputEl.value;
    }

    // Tiptap/ProseMirror/comfy-markdown编辑器
    if (inputEl.classList.contains('tiptap') ||
        inputEl.classList.contains('ProseMirror') ||
        inputEl.classList.contains('comfy-markdown')) {

        let targetEl = inputEl;
        // 对于comfy-markdown，查找内部编辑器元素
        if (inputEl.classList.contains('comfy-markdown')) {
            const editorEl = inputEl.querySelector('.tiptap, .ProseMirror');
            if (editorEl) {
                targetEl = editorEl;
            }
        }

        if (returnHtml) {
            return targetEl.innerHTML || '';
        }

        const textContent = targetEl.textContent || targetEl.innerText || '';
        if (textContent.trim()) {
            return textContent;
        }

        // 从widget.value获取
        if (widget.value !== undefined) {
            return widget.value;
        }

        // 从node.widgets找到对应的widget.value
        if (widget.node && widget.node.widgets) {
            const matchingWidget = widget.node.widgets.find(w =>
                w.name === widget.inputId || w.name === 'text'
            );
            if (matchingWidget && matchingWidget.value !== undefined) {
                return matchingWidget.value;
            }
        }
    }

    // contenteditable元素
    if (inputEl.isContentEditable || inputEl.getAttribute('contenteditable') === 'true') {
        if (returnHtml) {
            return inputEl.innerHTML || '';
        }
        return inputEl.textContent || inputEl.innerText || '';
    }

    // widget.value
    if (widget.value !== undefined && typeof widget.value === 'string') {
        return widget.value;
    }

    // inputWidget.value
    if (widget.inputWidget && widget.inputWidget.value !== undefined) {
        return widget.inputWidget.value;
    }

    return '';
}

/**
 * 设置输入元素的内容
 * 支持普通textarea、Tiptap编辑器、ProseMirror编辑器等
 * @param {object} widget - 小助手widget对象
 * @param {string} content - 要设置的内容
 * @param {object} options - 配置选项
 * @param {boolean} options.html - 是否作为 HTML 内容设置
 * @param {boolean} options.silent - 是否静默更新（不触发事件，用于流式输出）
 * @returns {boolean} 是否设置成功
 */
function setInputValue(widget, content, options = {}) {
    if (!widget || !widget.inputEl) {
        return false;
    }

    const inputEl = widget.inputEl;
    const useHtml = options.html === true;
    const silent = options.silent === true;  // 流式更新时不触发事件

    try {
        // 标准textarea
        if (inputEl.tagName === 'TEXTAREA' && inputEl.value !== undefined) {
            inputEl.value = content;

            // 关键修复：即使是 silent 模式，也需要同步 widget.value 和 node.widgets[].value
            // 否则后续 getInputValue 会读取到旧值
            if (widget.value !== undefined) {
                widget.value = content;
            }
            if (widget.node && widget.node.widgets) {
                const matchingWidget = widget.node.widgets.find(w =>
                    w.name === widget.inputId || w.name === 'text'
                );
                if (matchingWidget) {
                    matchingWidget.value = content;
                }
            }

            if (!silent) {
                inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                inputEl.dispatchEvent(new Event('change', { bubbles: true }));
            }
            return true;
        }

        // comfy-markdown或Tiptap/ProseMirror编辑器
        if (inputEl.classList.contains('comfy-markdown') ||
            inputEl.classList.contains('tiptap') ||
            inputEl.classList.contains('ProseMirror')) {

            // 对于comfy-markdown，找到内部编辑器
            let targetEl = inputEl;
            if (inputEl.classList.contains('comfy-markdown')) {
                const editorEl = inputEl.querySelector('.tiptap, .ProseMirror');
                if (editorEl) {
                    targetEl = editorEl;
                }
            }

            // 设置textContent/innerHTML
            if (targetEl.isContentEditable || targetEl.getAttribute('contenteditable') === 'true') {
                if (useHtml) {
                    targetEl.innerHTML = content;
                } else {
                    targetEl.textContent = content;
                }
            } else {
                targetEl.innerHTML = content;
            }

            // 触发输入事件（静默模式下跳过）
            if (!silent) {
                targetEl.dispatchEvent(new Event('input', { bubbles: true }));
                targetEl.dispatchEvent(new Event('change', { bubbles: true }));
            }

            // 同时更新widget.value（无论是否 silent 都需要同步）
            if (widget.value !== undefined) {
                widget.value = content;
            }

            // 同时更新node.widgets[].value（无论是否 silent 都需要同步）
            if (widget.node && widget.node.widgets) {
                const matchingWidget = widget.node.widgets.find(w =>
                    w.name === widget.inputId || w.name === 'text'
                );
                if (matchingWidget) {
                    matchingWidget.value = content;
                }
            }

            return true;
        }

        // contenteditable元素
        if (inputEl.isContentEditable || inputEl.getAttribute('contenteditable') === 'true') {
            if (useHtml) {
                inputEl.innerHTML = content;
            } else {
                inputEl.textContent = content;
            }

            // 关键修复：同步 widget.value 和 node.widgets[].value
            if (widget.value !== undefined) {
                widget.value = content;
            }
            if (widget.node && widget.node.widgets) {
                const matchingWidget = widget.node.widgets.find(w =>
                    w.name === widget.inputId || w.name === 'text'
                );
                if (matchingWidget) {
                    matchingWidget.value = content;
                }
            }

            if (!silent) {
                inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                inputEl.dispatchEvent(new Event('change', { bubbles: true }));
            }
            return true;
        }

        // widget.value
        if (widget.value !== undefined) {
            widget.value = content;
            return true;
        }

        return false;
    } catch (error) {
        logger.error(`[setInputValue] 设置失败 | 错误: ${error.message}`);
        return false;
    }
}

// ====================== 主类实现 ======================

/**
 * 提示词小助手主类
 * 统一管理小助手的生命周期、实例和资源
 */
class PromptAssistant {
    /** 存储所有小助手实例的Map集合 */
    static instances = new Map();

    constructor() {
        this.initialized = false;
    }

    /**
     * 【核心优化】统一获取助手实例的唯一键名
     * 解决子图节点 ID 冲突及不同扫描模式下的键名不一致问题
     */
    _getAssistantKey(node, inputId) {
        if (!node) return null;
        const graph = node.graph || app.graph;
        // 优先顺序：graph.id (Locator ID) -> graph._workflow_id -> 'main'
        const graphId = graph?.id || graph?._workflow_id || 'main';
        return `${graphId}_${node.id}_${inputId}`;
    }

    // ---生命周期管理功能---
    /**
     * 判断功能是否被禁用
     */
    areAllFeaturesDisabled() {
        return !window.FEATURES.enabled;
    }

    /**
     * 初始化提示词小助手
     */
    initialize() {
        if (this.initialized) return;

        try {
            // 检查版本号
            if (!window.PromptAssistant_Version) {
                logger.error("初始化时未找到版本号！这可能导致UI显示异常");
            } else {
                logger.debug(`初始化时检测到版本号: ${window.PromptAssistant_Version}`);
            }

            // 初始化事件管理器
            EventManager.init();

            // 从配置加载所有功能开关状态
            FEATURES.loadSettings();
            // 同步到 window.FEATURES 以兼容旧代码
            window.FEATURES.enabled = FEATURES.enabled;

            // 记录总开关状态（改为调试级别）
            logger.debug(`初始化时检测总开关状态 | 状态:${FEATURES.enabled ? "启用" : "禁用"}`);

            // 初始化资源管理器
            ResourceManager.init();

            // 只有在总开关打开时才做完整初始化
            if (window.FEATURES.enabled) {

            }

            this.initialized = true;
            logger.log("初始化完成 | 小助手已完全启动");
        } catch (error) {
            logger.error(`初始化失败 | 错误: ${error.message}`);
            // 重置状态
            this.initialized = false;
            window.FEATURES.enabled = false;
            // 确保清理
            this.cleanup();
        }
    }

    /**
     * 统一控制总开关功能
     * 集中管理所有受总开关控制的服务功能
     */
    async toggleGlobalFeature(enable, force = false) {
        // 更新状态
        const oldValue = window.FEATURES.enabled;
        window.FEATURES.enabled = enable;

        // 状态未变化时不执行操作，除非force为true
        if (!force && oldValue === enable) {
            return;
        }

        // 仅当状态真正变化或强制执行时才记录日志
        if (oldValue !== enable || force === true) {
            logger.log(`总开关 | 动作:${enable ? "启用" : "禁用"}`);
        }

        try {
            if (enable) {
                // === 启用所有服务 ===
                // 确保管理器已初始化
                if (!EventManager.initialized) {
                    EventManager.init();
                }

                if (!ResourceManager.isInitialized()) {
                    ResourceManager.init();
                }

                // 1. 重置节点初始化标记，准备重新检测
                if (app.canvas && app.canvas.graph) {
                    const nodes = app.canvas.graph._nodes || [];
                    nodes.forEach(node => {
                        if (node) {
                            node._promptAssistantInitialized = false;
                        }
                    });
                }

                // 2. 设置或恢复节点选择事件监听
                if (app.canvas) {
                    // 避免重复设置监听器
                    if (!app.canvas._promptAssistantSelectionHandler) {
                        app.canvas._promptAssistantSelectionHandler = function (selected_nodes) {
                            // 当总开关关闭时，跳过所有节点处理
                            if (!window.FEATURES.enabled) {
                                return;
                            }

                            if (selected_nodes && Object.keys(selected_nodes).length > 0) {
                                Object.keys(selected_nodes).forEach(nodeId => {
                                    const node = app.canvas.graph.getNodeById(nodeId);
                                    if (!node) return;

                                    // 初始化未初始化的节点
                                    if (!node._promptAssistantInitialized) {
                                        node._promptAssistantInitialized = true;
                                        this.checkAndSetupNode(node);
                                    }
                                });
                            }
                        }.bind(this);
                    }

                    // 保存当前监听器并设置新的
                    if (app.canvas.onSelectionChange && app.canvas.onSelectionChange !== app.canvas._promptAssistantSelectionHandler) {
                        app.canvas._originalSelectionChange = app.canvas.onSelectionChange;
                    }

                    app.canvas.onSelectionChange = app.canvas._promptAssistantSelectionHandler;

                    // 3. 如果开启了自动创建，立即扫描所有有效节点
                    const creationMode = app.ui.settings.getSettingValue("PromptAssistant.Settings.CreationMode") || "auto";
                    if (creationMode === "auto") {
                        const nodes = app.canvas.graph._nodes || [];
                        nodes.forEach(node => {
                            if (node && !node._promptAssistantInitialized) {
                                // 避免在扫描过程中重复处理
                                node._promptAssistantInitialized = true;
                                this.checkAndSetupNode(node);
                            }
                        });
                    }
                }
            } else {
                // === 禁用所有服务 ===

                // 1. 计数并清理所有实例
                const instanceCount = PromptAssistant.instances.size;
                this.cleanup(null, true);

                // 2. 恢复原始节点选择事件监听
                if (app.canvas) {
                    if (app.canvas._originalSelectionChange) {
                        app.canvas.onSelectionChange = app.canvas._originalSelectionChange;
                    } else {
                        app.canvas.onSelectionChange = null;
                    }
                }
            }

            // 按钮可见性更新在features中单独处理
            window.FEATURES.updateButtonsVisibility();


        } catch (error) {
            logger.error(`总开关操作失败 | 错误: ${error.message}`);
            // 恢复原始状态
            window.FEATURES.enabled = oldValue;
        }
    }

    // ---资源管理功能---
    /**
     * 清理所有资源
     */
    cleanup(nodeId = null, silent = false) {
        // 如果正在切换工作流，则只清理UI实例，不删除缓存
        if (window.PROMPT_ASSISTANT_WORKFLOW_SWITCHING) {
            // 简化日志：工作流切换期间不逐条打印节点清理日志，避免高频刷屏
            // 如需排查问题，可将下行改回 debug 单条输出
            // if (nodeId !== null) { logger.debug(`[清理跳过] 正在切换工作流，仅清理提示词小助手UI，节点ID: ${nodeId}`); }

            const keysToDelete = Array.from(PromptAssistant.instances.keys())
                .filter(key => nodeId === null || key.startsWith(`${String(nodeId)}_`));

            keysToDelete.forEach(key => {
                const instance = PromptAssistant.getInstance(key);
                if (instance) {
                    this._cleanupInstance(instance, key, false); // false表示从实例集合中移除
                }
            });

            // 如果是全局清理，清空实例集合
            if (nodeId === null) {
                PromptAssistant.instances.clear();
            }
            return;
        }

        // 检查Id是否有效
        if (nodeId !== null && nodeId !== undefined) {
            // 确保nodeId是字符串类型，便于后续比较
            const searchId = String(nodeId);

            // 获取所有匹配的实例键
            // 逻辑：匹配精确键 (graphId_nodeId_inputId) 或者以 nodeId_ 开头的旧键，或者包含 _nodeId_ 的全量键
            const keysToDelete = Array.from(PromptAssistant.instances.keys())
                .filter(key => {
                    // 1. 精确匹配（如果传入的是 assistantKey）
                    if (key === searchId) return true;
                    // 2. 匹配 nodeId (旧格式)
                    if (key.startsWith(`${searchId}_`)) return true;
                    // 3. 匹配带 graphId 前缀的格式 (graphId_nodeId_inputId)
                    const parts = key.split('_');
                    return parts.length >= 2 && parts[1] === searchId;
                });

            // 如果有实例需要清理
            if (keysToDelete.length > 0) {
                let historyCount = 0;
                let tagCount = 0;
                let instanceNames = [];

                try {
                    // 统计并清理历史记录
                    const allHistory = HistoryCacheService.getAllHistory();
                    historyCount = allHistory.filter(item => item.node_id === nodeId).length;
                    HistoryCacheService.clearNodeHistory(nodeId);

                    // 统计并清理标签缓存
                    keysToDelete.forEach(key => {
                        const instance = PromptAssistant.getInstance(key);
                        if (instance && instance.inputId) {
                            const tags = TagCacheService.getAllRawTags(nodeId, instance.inputId);
                            tagCount += tags ? tags.length : 0;
                            TagCacheService.clearCache(nodeId, instance.inputId);
                            instanceNames.push(instance.inputId);
                        }
                    });

                    // 清理实例
                    keysToDelete.forEach(key => {
                        const instance = PromptAssistant.getInstance(key);
                        if (instance) {
                            this._cleanupInstance(instance, key, true);
                            PromptAssistant.instances.delete(key);
                        }
                    });

                    if (!silent) {
                        // 获取当前剩余的统计信息
                        const remainingInstances = PromptAssistant.instances.size;
                        // 获取标签缓存统计
                        const tagStats = TagCacheService.getTagStats();
                        const remainingTags = tagStats.total;
                        const remainingHistory = HistoryCacheService.getAllHistory().length;

                        logger.log(`[清理汇总] 节点ID: ${nodeId} | 清理实例: ${instanceNames.join(', ')} | 历史记录清理: ${historyCount}条 | 标签缓存清理: ${tagCount}个`);
                    }
                } catch (error) {
                    logger.error(`[节点清理] 失败 | 节点ID: ${nodeId} | 错误: ${error.message}`);
                }
            }
            return;
        }

        // 清理所有实例和历史
        const beforeCleanupSize = PromptAssistant.instances.size;
        if (beforeCleanupSize > 0) {
            let totalHistoryCount = 0;
            let totalTagCount = 0;
            let allInstanceNames = [];

            try {
                // 统计并清理所有历史记录
                const allHistory = HistoryCacheService.getAllHistory();
                totalHistoryCount = allHistory.length;
                HistoryCacheService.clearAllHistory();

                // 统计标签缓存
                const tagStats = TagCacheService.getTagStats();
                totalTagCount = tagStats.total;

                // 清理所有标签缓存
                TagCacheService.clearAllTagCache();

                // 清理所有实例
                for (const [key, instance] of PromptAssistant.instances) {
                    if (instance) {
                        allInstanceNames.push(instance.inputId || key);
                        this._cleanupInstance(instance, key, true);
                    }
                }

                // 清空实例集合
                PromptAssistant.instances.clear();

                if (!silent) {
                    logger.log(`[全局清理] 实例: ${allInstanceNames.join(', ')} | 历史: ${totalHistoryCount}条 | 标签: ${totalTagCount}个`);
                    logger.log(`[剩余统计] 小助手实例: 0个 | 标签缓存: 0个 | 节点历史缓存: 0条`);
                }
            } catch (error) {
                logger.error(`[全局清理] 失败 | 错误: ${error.message}`);
            }
        }
    }

    // ---节点类型检测工具---

    /**
     * 检查节点是否为使用comfy-markdown的节点
     * 包括 Note、MarkdownNote、PreviewTextNode 等
     * @param {object} node - 节点对象
     * @returns {boolean}
     */
    _isMarkdownNode(node) {
        if (!node || !node.type) return false;
        const markdownNodeTypes = ['Note', 'MarkdownNote', 'PreviewAny', 'PreviewTextNode'];
        if (markdownNodeTypes.includes(node.type)) {
            return true;
        }
        const typeLower = node.type.toLowerCase();
        return typeLower.includes('markdown') ||
            (typeLower.includes('preview') && typeLower.includes('text')) ||
            typeLower.includes('subgraph'); // 增加对子图的基础判定支持
    }

    /**
     * 检查节点是否为子图节点 (Subgraph)
     * 子图节点的类型名为 UUID 格式
     * @param {object} node - 节点对象
     * @returns {boolean}
     */
    _isSubgraphNode(node) {
        if (!node || !node.type) return false;
        // UUID 格式：8-4-4-4-12 字符
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(node.type);
    }

    // ---实例管理功能---
    /**
     * 检查节点是否有效
     * Vue mode下Note/MarkdownNote/Subgraph节点需要特殊处理
     */
    static isValidNode(node) {
        if (!node || typeof node.id === 'undefined' || node.id === -1) {
            return false;
        }

        if (typeof node.type !== 'string') {
            return false;
        }

        // Vue mode下的特殊节点类型（可能没有标准widgets属性）
        const isVueMode = typeof LiteGraph !== 'undefined' && LiteGraph.vueNodesMode === true;
        const vueSpecialNodeTypes = ['Note', 'MarkdownNote', 'PreviewAny', 'PreviewTextNode'];

        // 检查是否为markdown类型节点
        const isMarkdownNode = vueSpecialNodeTypes.includes(node.type) ||
            (node.type && node.type.toLowerCase().includes('markdown')) ||
            (node.type && node.type.toLowerCase().includes('preview') && node.type.toLowerCase().includes('text'));

        // 检查是否为子图节点
        // 1. UUID 格式类型名 (Node 2.0 动态创建)
        const isUUIDType = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(node.type);
        // 2. 原生 Subgraph 关键字或 workflow/ 前缀
        const isSubgraphType = node.type === 'Subgraph' ||
            node.type.startsWith('workflow/') ||
            (node.constructor && node.constructor.name === 'Subgraph');

        if (isVueMode && (isMarkdownNode || isUUIDType || isSubgraphType)) {
            // logger.debug(`[isValidNode] Vue+Special match: ${node.type}`);
            return true;
        }

        const valid = !!node.widgets;
        if (!valid) {
            // logger.debug(`[isValidNode] Fallback check: ${node.type}`);
        }
        // 标准检查：需要有widgets属性
        return valid;
    }

    /**
     * 添加实例到管理器
     */
    static addInstance(nodeId, widget) {
        if (nodeId != null && widget != null) {
            this.instances.set(String(nodeId), widget);
            return true;
        }
        return false;
    }

    /**
     * 获取实例
     */
    static getInstance(key) {
        if (key == null) return null;
        return this.instances.get(String(key));
    }

    /**
     * 检查实例是否存在
     */
    static hasInstance(key) {
        if (key == null) return false;
        return this.instances.has(String(key));
    }

    /**
     * 检查节点并设置小助手
     * 查找节点中的有效输入控件并创建小助手
     */
    checkAndSetupNode(node) {
        // 快速检查
        if (!window.FEATURES.enabled || !node) return;

        const isVueMode = LiteGraph.vueNodesMode === true;
        const graph = node.graph || app.graph;
        const graphId = graph?.id || graph?._workflow_id || 'main';



        // Vue mode下特殊节点（Note/Markdown/Subgraph）即使没有 LiteGraph widgets 也是有效的
        if (!node.widgets) {

            if (isVueMode && PromptAssistant.isValidNode(node)) {
                this._handleVueDomScanNode(node);
            }
            return;
        }

        // 后续检查：如果虽然有 widgets 但不是我们识别的有效节点，也回退处理
        const isValid = PromptAssistant.isValidNode(node);
        if (!isValid) {

            return;
        }

        // 获取所有有效的输入控件
        const validInputs = node.widgets.filter(widget => {
            if (!widget.node) widget.node = node;
            const isValidInput = UIToolkit.isValidInput(widget, { debug: false, node: node });

            return isValidInput;
        });



        if (validInputs.length === 0) {
            // 非目标节点类型（如 LoadImage）没有文本控件是正常的，使用 debug 级别
            logger.debug(`[checkAndSetupNode] 节点无有效控件 | ID: ${node.id} | 类型: ${node.type}`);

            // Vue mode下节点可能暂时没有识别到 LiteGraph 控件，强制回退到 DOM 扫描模式
            if (isVueMode && isValid) {
                this._handleVueDomScanNode(node);
            }
            return;
        }

        // 为每个有效控件创建小助手
        validInputs.forEach((inputWidget, widgetIndex) => {
            const inputId = inputWidget.name || inputWidget.id;

            // --- 核心修复：多图支持的唯一键 ---
            let assistantKey = this._getAssistantKey(node, inputId);

            // 检查是否存在同名的输入框，如果存在则使用索引或 DOM 元素的唯一标识
            const sameNameWidgets = validInputs.filter(w => (w.name || w.id) === inputId);
            if (sameNameWidgets.length > 1) {
                // 多个同名输入框，使用索引或输入框元素的内存地址作为唯一标识
                const inputEl = inputWidget.inputEl || inputWidget.element;
                if (inputEl) {
                    // 为输入框元素添加唯一标识
                    if (!inputEl.dataset.promptAssistantUniqueId) {
                        inputEl.dataset.promptAssistantUniqueId = `${graphId}_${node.id}_${inputId}_${widgetIndex}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                    }
                    assistantKey = inputEl.dataset.promptAssistantUniqueId;
                } else {
                    // 降级方案：使用索引
                    assistantKey = `${graphId}_${node.id}_${inputId}_${widgetIndex}`;
                }
            }

            // 检查实例是否已存在
            if (PromptAssistant.hasInstance(assistantKey)) {
                // 如果实例存在，检查输入控件是否已更新，或者 UI 元素是否已丢失
                const instance = PromptAssistant.getInstance(assistantKey);
                const currentInputEl = inputWidget.inputEl;
                const instanceInputEl = instance?.text_element;
                const instanceUIEl = instance?.element;

                // 检查 UI 元素是否仍然在 DOM 中
                const isVueMode = nodeMountService.isVueNodesMode();
                const nodeContainer = isVueMode ? document.querySelector(`[data-node-id="${node.id}"]`) : null;
                const isUIPresent = isVueMode ? nodeContainer?.contains(instanceUIEl) : document.body.contains(instanceUIEl);

                // --- 修复：处理挂载竞争状态 ---
                // 如果 UI 元素丢失，或者输入元素引用变化且原元素已移除，则清理并重建
                // 增加 _isMounting 标记检查，避免异步挂载期间被误判为丢失
                if (!instanceUIEl || (!isUIPresent && !instance._isMounting)) {
                    logger.debug(() => `[checkAndSetupNode] UI 元素已丢失，清理实例以触发重建 | 节点ID: ${node.id} | 键: ${assistantKey}`);
                    // 传入完整的 assistantKey 以确保精确清理
                    this.cleanup(assistantKey);
                } else if (!isUIPresent && instance._isMounting) {
                    // 正在挂载中，跳过
                    return;
                } else if (instanceInputEl && currentInputEl && instanceInputEl !== currentInputEl) {
                    // 进一步检查：确保确实需要重建（避免误判）
                    // 如果当前元素已经从 DOM 中移除，才需要清理
                    if (!document.body.contains(instanceInputEl)) {
                        logger.debug(() => `[checkAndSetupNode] 输入元素已失效，清理实例 | 节点ID: ${node.id}`);
                        this.cleanup(node.id);
                    } else {
                        return;
                    }
                } else {
                    // 实例存在且一切正常，跳过
                    return;
                }
            }

            // 再次检查总开关状态，确保在创建过程中没有被禁用
            if (!window.FEATURES.enabled) {
                return;
            }

            // 【防重复挂载检查】在创建前检查 inputEl 是否已被其他实例挂载
            const inputEl = inputWidget.inputEl || inputWidget.element;
            if (inputEl && inputEl._promptAssistantMounted) {
                return;
            }

            // 创建小助手实例
            const assistant = this.setupNodeAssistant(node, inputWidget, assistantKey);
            if (assistant) {
                logger.debugSample(() => `[小助手] 创建实例 | 节点:${node.id} | 控件:${inputId} | 索引:${widgetIndex}`);
            }
        });
    }

    /**
 * Vue mode 下对特殊或动态节点（Note/Subgraph等）的 DOM 扫描处理
 * 当 LiteGraph widgets 尚未就绪时，直接从 DOM 中扫描 textarea 并挂载
 */
    _handleVueDomScanNode(node) {
        if (!node) return;

        const isMarkdown = this._isMarkdownNode(node);
        const isSubgraph = this._isSubgraphNode(node);

        // logger.debug(`[_handleVueDomScanNode] Scanning: ${node.type}`);

        // 仅处理我们识别的有效节点
        if (!isMarkdown && !isSubgraph) return;

        const nodeId = node.id;

        // 使用 NodeMountService 提供的逻辑，在 DOM 容器中查找所有潜在的输入框
        const nodeContainer = document.querySelector(`[data-node-id="${nodeId}"]`);
        if (!nodeContainer) {
            // 如果容器还没渲染，则启动一次带重试的单次挂载尝试（针对主要输入框）
            if (isMarkdown) {
                this._retryDomScan(node, 'text');
            }
            return;
        }

        // 查找所有 textarea（优先找 PrimeVue 的 .p-textarea）
        const primeTextareas = Array.from(nodeContainer.querySelectorAll('textarea.p-textarea'));
        const textareas = primeTextareas.length > 0 ? primeTextareas : Array.from(nodeContainer.querySelectorAll('textarea'));

        if (textareas.length === 0) {
            // 可能是 TipTap 编辑器（针对 Note 节点）
            const editor = nodeContainer.querySelector('.tiptap') || nodeContainer.querySelector('.ProseMirror');
            // logger.debug(`[Vue扫描] 节点无文本框 | ID: ${node.id}`);
            if (editor) {
                this._mountDomAssistant(node, editor, 'text', 0);
            }
            return;
        }

        // 遍历所有找到的 textarea 并尝试挂载
        textareas.forEach((el, index) => {
            // 生成 Key：对于 Note 节点通常只有一个，对于子图有多个
            const inputId = textareas.length === 1 ? 'text' : `input_${index}`;
            this._mountDomAssistant(node, el, inputId, index);
        });
    }

    /**
     * 执行实际的 DOM 挂载
     */
    _mountDomAssistant(node, element, inputId, index) {
        const assistantKey = this._getAssistantKey(node, inputId);
        if (PromptAssistant.hasInstance(assistantKey)) {
            const instance = PromptAssistant.getInstance(assistantKey);
            const isVueMode = nodeMountService.isVueNodesMode();
            const nodeContainer = isVueMode ? document.querySelector(`[data-node-id="${node.id}"]`) : null;
            const isUIPresent = isVueMode ? nodeContainer?.contains(instance?.element) : document.body.contains(instance?.element);

            if (instance?.element && isUIPresent) {
                return;
            }

            // 实例存在但 UI 丢失，清理旧实例以便重建
            logger.debug(() => `[_mountDomAssistant] 检测到孤立实例，清理重建 | 节点ID: ${node.id}`);
            this.cleanup(node.id);
        }

        // 检查元素是否已被挂载 (基于 DOM 属性判断)
        if (element._promptAssistantMounted) {
            // 如果属性还在但实例在 Map 中没了，或者 UI 确实不可见了，应该允许重新挂载
            // 这里我们保持原样，通过上面的 cleanup 保证一致性
            return;
        }

        // 创建虚拟 widget
        const virtualWidget = {
            name: inputId, id: inputId, type: 'textarea',
            inputEl: element, element: element, node: node,
            _domIndex: index // 记录 DOM 索引
        };

        const nodeInfo = {
            workflow_id: app.graph?._workflow_id || 'unknown',
            nodeType: node.type, inputType: 'text',
            isNoteNode: this._isMarkdownNode(node),
            isSubgraph: this._isSubgraphNode(node),
            isVueMode: true,
            domIndex: index
        };

        const assistant = this.createAssistant(node, inputId, virtualWidget, nodeInfo, assistantKey);
        if (assistant) {
            this.showAssistantUI(assistant);
            // logger.debugSample(() => `[DOM扫描] ${node.type}节点挂载成功 | ID: ${node.id} | Key: ${assistantKey}`);
        }
    }

    /**
     * 针对初始 DOM 未就绪的情况进行一次带重试的扫描
     */
    _retryDomScan(node, inputId) {
        const widgetStub = { name: inputId, node: node };
        nodeMountService.findMountContainerWithRetry(node, widgetStub, { timeout: 2000 })
            .then(result => {
                if (result && result.textarea) {
                    this._mountDomAssistant(node, result.textarea, inputId, 0);
                }
            });
    }

    /**
     * 为节点设置小助手
     * 创建小助手实例并初始化显示状态
     */
    setupNodeAssistant(node, inputWidget, assistantKey = null) {


        // 简化参数检查
        if (!node || !inputWidget) {
            logger.error(`[setupNodeAssistant] 参数无效 | node: ${!!node} | inputWidget: ${!!inputWidget}`);
            return null;
        }

        try {
            const nodeId = node.id;
            const inputId = inputWidget.name || inputWidget.id || Math.random().toString(36).substring(2, 10);
            const isNoteNode = this._isMarkdownNode(node);
            const isVueMode = typeof LiteGraph !== 'undefined' && LiteGraph.vueNodesMode === true;



            // 简化节点信息
            const nodeInfo = {
                workflow_id: app.graph?._workflow_id || 'unknown',
                nodeType: node.type,
                inputType: inputId,
                isNoteNode: isNoteNode,
                isVueMode: isVueMode
            };

            // 处理inputWidget的inputEl引用
            let processedWidget = inputWidget;
            if (isNoteNode) {
                const inputEl = inputWidget.element || inputWidget.inputEl;
                processedWidget = {
                    ...inputWidget,
                    inputEl: inputEl,
                    _needsDelayedTextareaLookup: isVueMode && !inputEl
                };
            }
            // 补充注入查找到的真实 textarea (解决 Litegraph 下 PromotedWidgetView 获取不到 inputEl 导致中止的问题)
            const mountContainer = nodeMountService.findMountContainer(node, inputWidget);
            if (mountContainer && mountContainer.textarea) {
                processedWidget = Object.create(processedWidget);
                processedWidget.inputEl = mountContainer.textarea;
                processedWidget.element = mountContainer.textarea;
            }

            // 创建小助手实例

            const assistant = this.createAssistant(
                node,
                inputId,
                processedWidget,
                nodeInfo,
                assistantKey
            );

            if (assistant) {

                // 初始化显示状态
                // 初始化显示状态
                this.showAssistantUI(assistant);
                return assistant;
            } else {
                console.warn(`[setupNodeAssistant] ⚠️ createAssistant 返回 null`);
            }

            return null;
        } catch (error) {
            logger.error(`[setupNodeAssistant] ❌ 异常 | 节点: ${node.id} | 错误:`, error);
            logger.error(`创建小助手失败 | 节点ID: ${node.id} | 原因: ${error.message}`);
            return null;
        }
    }

    /**
     * 创建小助手实例
     * 根据节点和输入控件构建小助手对象并初始化UI
     */
    createAssistant(node, inputId, inputWidget, nodeInfo = {}, assistantKey = null) {


        // 简化前置检查
        if (!window.FEATURES.enabled || !node || !inputId || !inputWidget) {
            logger.error(`[createAssistant] ❌ 前置检查失败 | enabled: ${window.FEATURES.enabled} | node: ${!!node} | inputId: ${inputId} | inputWidget: ${!!inputWidget}`);
            return null;
        }


        // 确保widget设置了node引用
        if (!inputWidget.node) {
            inputWidget.node = node;
        }

        // 验证是否为有效输入

        if (!UIToolkit.isValidInput(inputWidget, { node: node })) {
            console.warn(`[createAssistant] ⚠️ 输入无效 | 节点: ${node?.id} | 控件: ${inputId}`);
            return null;
        }


        // 获取输入元素
        let inputEl = inputWidget.inputEl || inputWidget.element;
        const isVueMode = typeof LiteGraph !== 'undefined' && LiteGraph.vueNodesMode === true;



        // 非Vue mode下，inputEl必须存在
        if (!inputEl && !isVueMode) {
            logger.error(`[createAssistant] ❌ 非Vue模式下inputEl不存在 | 节点: ${node?.id}`);
            return null;
        }

        const nodeId = node.id;
        const widgetKey = assistantKey || this._getAssistantKey(node, inputId);



        // 检查是否已存在实例
        if (PromptAssistant.hasInstance(widgetKey)) {

            return PromptAssistant.getInstance(widgetKey);
        }



        // 创建小助手对象
        const widget = {
            type: "prompt_assistant",
            name: inputId,
            nodeId,
            inputId,
            widgetKey,
            buttons: {},
            text_element: inputEl,
            inputEl: inputEl,
            isDestroyed: false,
            _isMounting: true, // 标记挂载中状态
            nodeInfo: {
                ...nodeInfo,
                nodeId: nodeId,
                nodeType: node.type,
                isVueMode: isVueMode
            },
            isTransitioning: false,
            // 保存初始节点引用作为后备（Vue Node 2.0 子图切换场景）
            _initialNode: node
        };

        // 动态获取节点的 getter，避免持有已删除节点的引用
        // 【修复】优先从 graph 获取，失败时回退到初始引用（解决子图切换时画布未同步问题）
        Object.defineProperty(widget, 'node', {
            get() {
                if (this.isDestroyed) return null;
                // 优先从当前画布 graph 动态获取
                const graphNode = app.canvas?.graph?._nodes_by_id?.[this.nodeId];
                if (graphNode) return graphNode;
                // 回退：使用初始节点引用（如果仍有效）
                if (this._initialNode && this._initialNode.id === this.nodeId) {
                    return this._initialNode;
                }
                return null;
            },
            configurable: true
        });



        // 创建全局输入框映射
        if (!window.PromptAssistantInputWidgetMap) {
            window.PromptAssistantInputWidgetMap = {};
        }

        window.PromptAssistantInputWidgetMap[widgetKey] = {
            inputEl: inputEl,
            widget: widget
        };



        // 创建UI并添加到实例集合
        this.createAssistantUI(widget, inputWidget);

        PromptAssistant.addInstance(widgetKey, widget);



        // 初始化绑定
        if (inputEl) {
            this._initializeInputElBindings(widget, inputWidget, node, inputId, nodeInfo);
        } else {

        }


        return widget;
    }

    /**
     * 初始化inputEl相关的事件绑定
     * 在传统模式下立即调用，Vue mode下在找到textarea后调用
     */
    _initializeInputElBindings(widget, inputWidget, node, inputId, nodeInfo) {
        const inputEl = inputWidget.inputEl || widget.inputEl;
        if (!inputEl) {
            logger.warn(`[_initializeInputElBindings] inputEl不存在 | 节点ID: ${node?.id}`);
            return;
        }

        const nodeId = node.id;

        // 初始化撤销状态（只初始化一次，使用widget级别的标记）
        if (!widget._undoStateInitialized) {
            const initialValue = inputEl.value || '';
            // 如果初始值不为空，则直接添加到历史记录中，确保可以撤销回初始状态
            if (initialValue.trim()) {
                HistoryCacheService.addHistoryAndUpdateUndoState(nodeId, inputId, initialValue, 'input');
            } else {
                HistoryCacheService.initUndoState(nodeId, inputId, initialValue);
            }
            widget._undoStateInitialized = true;
        }
        // 初始化时立即更新撤销/重做按钮状态
        UIToolkit.updateUndoRedoButtonState(widget, HistoryCacheService);

        // 检查是否已绑定事件（避免重复绑定）
        // 【关键修复】使用 widget 级别的标记来精确控制绑定状态
        // 确保不会因为 _eventCleanupFunctions 中包含其他清理函数（如按钮菜单）而误判
        if (widget._inputEventsBound) {
            logger.debug(`[_initializeInputElBindings] 跳过绑定 | 节点ID: ${nodeId} | 原因: 已绑定`);
            return;
        }

        // 如果检测到遗留标记，静默处理

        inputEl._promptAssistantBound = true;
        widget._inputEventsBound = true;
        widget._eventCleanupFunctions = widget._eventCleanupFunctions || [];

        // 绑定输入框失焦事件，写入历史
        // 使用事件管理器添加DOM事件监听
        const removeBlurListener = EventManager.addDOMListener(inputEl, 'blur', async () => {
            // logger.debug(`历史写入准备｜ 原因：失焦事件触发 node_id=${node.id} input_id=${inputId}`);
            HistoryCacheService.addHistory({
                workflow_id: nodeInfo?.workflow_id || '',
                node_id: node.id,
                input_id: inputId,
                content: inputEl.value,
                operation_type: 'input',
                timestamp: Date.now()
            });
            // 重置撤销状态
            HistoryCacheService.initUndoState(node.id, inputId, inputEl.value);
            // 更新按钮状态
            UIToolkit.updateUndoRedoButtonState(widget, HistoryCacheService);
            // logger.debug(`历史写入完成｜原因：输入框失焦 node_id=${node.id} input_id=${inputId}`);
        });

        // 保存清理函数引用，以便后续清理
        widget._eventCleanupFunctions = widget._eventCleanupFunctions || [];
        widget._eventCleanupFunctions.push(removeBlurListener);

        // 添加输入事件监听，实时更新撤销/重做按钮状态和位置调整
        const removeInputListener = EventManager.addDOMListener(inputEl, 'input', () => {
            UIToolkit.updateUndoRedoButtonState(widget, HistoryCacheService);
            // 检测滚动条状态并调整位置
            this._adjustPositionForScrollbar(widget, inputEl);
        });
        widget._eventCleanupFunctions.push(removeInputListener);

        // 添加ResizeObserver监听输入框尺寸变化
        if (window.ResizeObserver) {
            const resizeObserver = new ResizeObserver(() => {
                // 延迟执行，确保浏览器完成布局更新
                setTimeout(() => {
                    this._adjustPositionForScrollbar(widget, inputEl);
                }, 10);
            });

            resizeObserver.observe(inputEl);

            // 添加清理函数
            widget._eventCleanupFunctions.push(() => {
                resizeObserver.disconnect();
            });
        } else {
            // 降级方案：监听window resize事件
            const removeResizeListener = EventManager.addDOMListener(window, 'resize',
                EventManager.debounce(() => {
                    this._adjustPositionForScrollbar(widget, inputEl);
                }, 100)
            );
            widget._eventCleanupFunctions.push(removeResizeListener);
        }
    }

    // ---UI管理功能---
    /**
     * 创建小助手UI
     * 构建DOM元素并设置事件监听和初始样式
     */
    createAssistantUI(widget, inputWidget) {
        const nodeId = widget.nodeId;
        const inputId = widget.inputId;



        try {

            // Get location setting
            const locationSetting = app.ui.settings.getSettingValue(
                "PromptAssistant.Location"
            );



            // Create AssistantContainer instance
            const container = new AssistantContainer({
                nodeId: nodeId,
                type: 'prompt',
                anchorPosition: locationSetting,
                enableDragSort: true,
                onButtonOrderChange: (order) => {
                    logger.debug(`[排序更新] 节点:${nodeId} | 新顺序: ${order.join(',')}`);
                },
                shouldCollapse: () => {
                    return !this._checkAssistantActiveState(widget);
                }
            });



            // Render container
            const containerEl = container.render();



            // Set Icon
            const mainIcon = ResourceManager.getIcon('icon-main.svg');
            if (mainIcon) {
                if (container.indicator) {
                    container.indicator.innerHTML = '';
                    container.indicator.appendChild(mainIcon);
                }
            }



            // Save references
            widget.container = container;
            widget.element = containerEl;
            widget.innerContent = container.content;
            widget.hoverArea = container.hoverArea;
            widget.indicator = container.indicator;
            widget.buttons = {};

            Object.defineProperty(widget, 'isCollapsed', {
                get: () => container.isCollapsed,
                set: (val) => {
                    if (val) container.collapse(); else container.expand();
                }
            });
            Object.defineProperty(widget, 'isTransitioning', {
                get: () => container.isTransitioning,
                set: (val) => { container.isTransitioning = val; }
            });



            // Initialize buttons
            this.addFunctionButtons(widget);



            // Restore button order
            container.restoreOrder();



            // Setup Positioning
            const inputEl = inputWidget.inputEl || widget.inputEl;
            const graphCanvasContainer = document.querySelector('.graphcanvas');
            const canvasContainerRect = graphCanvasContainer?.getBoundingClientRect();




            this._setupUIPosition(widget, inputEl, containerEl, canvasContainerRect, inputWidget, (success) => {

                if (widget.isDestroyed) {
                    logger.debug(`[定位] 回调跳过：实例已销毁 | ID: ${nodeId}`);
                    return;
                }

                if (!success) {
                    logger.debugSample(() => `[小助手] 创建暂缓 | 节点ID: ${nodeId} | 原因: 定位容器未就绪 (等待DOM渲染)`);
                    container.destroy();
                    const widgetKey = widget.widgetKey;
                    if (widgetKey && PromptAssistant.instances.has(widgetKey)) {
                        PromptAssistant.instances.delete(widgetKey);
                    }
                    if (window.PromptAssistantInputWidgetMap && widgetKey) {
                        delete window.PromptAssistantInputWidgetMap[widgetKey];
                    }
                    return;
                }

                // 定位成功后更新尺寸
                container.updateDimensions();
                // 挂载完成，清除标记
                widget._isMounting = false;
            });

            return containerEl;
        } catch (error) {
            console.error(`[createAssistantUI] ❌ 异常 | 节点: ${nodeId} | 错误:`, error);
            logger.error(`创建小助手失败 | 节点ID: ${nodeId} | 原因: ${error.message}`);
            return null;
        }
    }

    /**
     * 显示小助手UI
     * 控制UI显示动画和状态，创建时直接以折叠状态显示
     */
    showAssistantUI(widget, forceAnimation = false) {
        if (!widget?.element) return;

        // 避免重复显示
        if (widget.element.classList.contains('assistant-show')) {
            // 确保元素可见
            widget.element.style.display = 'flex';
            widget.element.style.opacity = '1';
            return;
        }

        // 直接显示，无动画过渡
        widget.element.style.opacity = '1';
        widget.element.style.display = 'flex';
        widget.element.classList.add('assistant-show');

        // 确保悬停区域可见（用于折叠状态下的交互）
        if (widget.isCollapsed && widget.hoverArea) {
            widget.hoverArea.style.display = 'block';
        }

        // 重置过渡状态
        widget.isTransitioning = false;

        // 只有当明确不是折叠状态时才触发自动折叠
        if (!widget.isCollapsed) {
            this.triggerAutoCollapse(widget);
        }
    }

    /**
     * 检查并触发自动折叠（如果需要）
     */
    _triggerAutoCollapseIfNeeded(widget) {
        if (widget && widget.container) {
            widget.container.collapse();
        }
    }




    /**
     * 展开小助手
     */
    _expandAssistant(widget) {
        if (widget && widget.container) {
            widget.container.expand();
        }
    }



    /**
     * 公开方法：触发小助手自动折叠
     * 供外部模块调用，用于在操作完成后折叠小助手UI
     */
    triggerAutoCollapse(widget) {
        return this._triggerAutoCollapseIfNeeded(widget);
    }

    /**
     * 更新小助手可见性
     * 始终显示小助手，不再根据鼠标悬停状态来决定
     */
    updateAssistantVisibility(widget) {
        if (!widget) return;

        // 总开关关闭时不处理可见性更新
        if (!window.FEATURES || !window.FEATURES.enabled) {
            return;
        }

        // 检查是否有按钮处于激活或处理中状态
        const hasActiveButtons = this._checkAssistantActiveState(widget);

        // 如果有激活的按钮，强制显示小助手（带动画）并取消自动折叠
        if (hasActiveButtons) {
            this.showAssistantUI(widget, true);

            // 取消可能的自动折叠定时器
            if (widget._autoCollapseTimer) {
                clearTimeout(widget._autoCollapseTimer);
                widget._autoCollapseTimer = null;
            }

            // 如果当前是折叠状态，则展开 - 使用requestAnimationFrame
            if (widget.isCollapsed) {
                requestAnimationFrame(() => {
                    this._expandAssistant(widget);
                });
            }

            return;
        }

        // 始终显示小助手，不再检查鼠标状态
        const isCurrentlyShown = widget.element?.classList.contains('assistant-show');
        if (!isCurrentlyShown) {
            this.showAssistantUI(widget, false);
            logger.debug(`UI显示 | 节点:${widget.nodeId} | 原因:始终显示`);
        } else {
            // 已经显示，检查是否需要自动折叠
            this.triggerAutoCollapse(widget);
        }
    }

    /**
     * 检查小助手是否有按钮处于激活状态
     */
    _checkAssistantActiveState(widget) {
        if (!widget || !widget.buttons) return false;

        // 0. 检查是否正在切换弹窗（切换期间不允许折叠）
        if (PopupManager._isTransitioning) {
            return true;
        }

        // 1. 检查右键菜单是否可见（并且属于当前 widget）
        if (buttonMenu.isMenuVisible && buttonMenu.menuContext?.widget === widget) {
            return true;
        }

        // 2. 检查中央按钮状态管理器是否有该widget的激活按钮
        const activeButtonInfo = UIToolkit.getActiveButtonInfo();
        if (activeButtonInfo && activeButtonInfo.widget === widget) {
            return true;
        }

        // 3. 检查 PopupManager 的活动弹窗是否属于当前 widget
        if (PopupManager.activePopupInfo?.buttonInfo?.widget === widget) {
            return true;
        }

        // 4. 检查按钮的 active/processing 状态
        for (const buttonId in widget.buttons) {
            const button = widget.buttons[buttonId];
            if (button.classList.contains('button-active') ||
                button.classList.contains('button-processing')) {
                return true;
            }
        }

        return false;
    }

    /**
     * 更新所有实例的可见性
     * 在按钮状态变化时调用
     */
    updateAllInstancesVisibility() {
        PromptAssistant.instances.forEach(widget => {
            this.updateAssistantVisibility(widget);
        });
    }

    /**
     * 更新所有实例的预设宽度
     * 在功能开关变更时调用，重新计算并设置宽度
     */
    updateAllInstancesWidth() {
        // 优化：不再手动计算宽度并注入，而是触发每个容器自身的常量布局逻辑
        logger.debug(`[布局更新] 触发所有实例尺寸重算 | 实例数量:${PromptAssistant.instances.size}`);

        PromptAssistant.instances.forEach((widget) => {
            if (widget && widget.container && typeof widget.container.updateDimensions === 'function') {
                widget.container.updateDimensions();
            }
        });
    }

    /**
     * 显示状态提示
     * 创建临时提示信息气泡
     */
    showStatusTip(anchorElement, type, message, position = null) {
        return UIToolkit.showStatusTip(anchorElement, type, message, position);
    }

    // ---事件处理功能---
    /**
     * 设置UI事件处理
     * 配置按钮事件监听 - 简化版本
     */
    _setupUIEventHandling(widget, inputEl, containerDiv) {
        // 事件处理已委托给 AssistantContainer
        // 我们保留此方法是为了兼容外部调用，但现在它不执行任何操作。
    }



    // ---辅助功能---
    /**
     * 更新输入框内容并添加高亮效果
     */
    updateInputWithHighlight(widget, content, options = {}) {
        if (!widget?.inputEl) return;

        try {
            // 更新输入框内容 - 使用统一的setInputValue函数
            const success = setInputValue(widget, content, options);

            if (!success) {
                logger.warn(`输入框更新 | 结果:失败 | setInputValue返回false`);
                return;
            }

            // 使用统一的高亮工具方法 (处理了定时器管理和重绘)
            UIToolkit._highlightInput(widget.inputEl);
        } catch (error) {
            logger.error(`输入框更新 | 结果:异常 | 错误:${error.message}`);
        }
    }

    // ---按钮管理功能---
    /**
     * 添加功能按钮
     */
    addFunctionButtons(widget) {
        if (!widget?.element) {
            logger.error('添加按钮 | 结果:失败 | 原因: 容器不存在');
            return;
        }

        // 检查总开关状态
        if (!FEATURES.enabled) {
            logger.debug('添加按钮 | 结果:跳过 | 原因: 总功能已禁用');
            return;
        }

        // 检查是否有至少一个功能启用
        const hasEnabledFeatures = FEATURES.history || FEATURES.tag || FEATURES.expand || FEATURES.translate;
        if (!hasEnabledFeatures) {
            logger.debug('添加按钮 | 结果:跳过 | 原因: 没有启用任何功能');
            return;
        }

        // 检查是否是Note/MarkdownNote节点
        const isNoteNode = widget.nodeInfo && (widget.nodeInfo.isNoteNode === true || widget.nodeInfo.nodeType === 'MarkdownNote');

        // 获取历史状态（用于初始化撤销/重做按钮状态）
        const canUndo = HistoryCacheService.canUndo(widget.nodeId, widget.inputId);
        const canRedo = HistoryCacheService.canRedo(widget.nodeId, widget.inputId);

        // 按钮配置
        const buttonConfigs = [
            {
                id: 'history',
                title: '历史',
                icon: 'icon-history',
                onClick: (e, widget) => {
                    UIToolkit.handlePopupButtonClick(
                        e,
                        widget,
                        'history',
                        HistoryManager.showHistoryPopup.bind(HistoryManager),
                        HistoryManager.hideHistoryPopup.bind(HistoryManager)
                    );
                },
                visible: !isNoteNode && FEATURES.history, // Note节点不显示此按钮
                initialState: { disabled: false }
            },
            {
                id: 'undo',
                title: '撤销',
                icon: 'icon-undo',
                onClick: (e, widget) => {
                    e.preventDefault();
                    e.stopPropagation();
                    logger.debug('按钮点击 | 动作: 撤销');

                    // 执行撤销操作
                    const undoContent = HistoryCacheService.undo(widget.nodeId, widget.inputId);
                    if (undoContent !== null) {
                        // 更新输入框内容并添加高亮效果
                        this.updateInputWithHighlight(widget, undoContent);

                        // 更新按钮状态
                        UIToolkit.updateUndoRedoButtonState(widget, HistoryCacheService);

                        logger.debug(`撤销操作 | 结果:成功 | 节点:${widget.nodeId}`);
                    } else {
                        logger.debug(`撤销操作 | 结果:失败 | 节点:${widget.nodeId} | 原因:无可用内容`);
                    }
                },
                visible: !isNoteNode && FEATURES.history,
                initialState: { disabled: !canUndo }
            },
            {
                id: 'redo',
                title: '重做',
                icon: 'icon-redo',
                onClick: (e, widget) => {
                    e.preventDefault();
                    e.stopPropagation();
                    logger.debug('按钮点击 | 动作: 重做');

                    // 执行重做操作
                    const redoContent = HistoryCacheService.redo(widget.nodeId, widget.inputId);
                    if (redoContent !== null) {
                        // 更新输入框内容并添加高亮效果
                        this.updateInputWithHighlight(widget, redoContent);

                        // 更新按钮状态
                        UIToolkit.updateUndoRedoButtonState(widget, HistoryCacheService);

                        logger.debug(`重做操作 | 结果:成功 | 节点:${widget.nodeId}`);
                    } else {
                        logger.debug(`重做操作 | 结果:失败 | 节点:${widget.nodeId} | 原因:无可用内容`);
                    }
                },
                visible: !isNoteNode && FEATURES.history,
                initialState: { disabled: !canRedo }
            },
            {
                id: 'divider1',
                type: 'divider',
                visible: !isNoteNode && FEATURES.history // Note节点不显示，且跟随历史功能开关
            },
            {
                id: 'tag',
                title: '标签工具',
                icon: 'icon-tag',
                onClick: (e, widget) => {
                    // 创建一个带有标签选择功能的显示函数
                    const showTagPopup = (options) => {
                        // 处理标签选择功能
                        const enhancedOptions = {
                            ...options,
                            onTagSelect: (tag) => {
                                // 获取当前输入框的值和光标位置
                                const currentValue = widget.inputEl.value;
                                const cursorPos = widget.inputEl.selectionStart;
                                const beforeText = currentValue.substring(0, cursorPos);
                                const afterText = currentValue.substring(widget.inputEl.selectionEnd);

                                // 添加标签（英文值）
                                const newValue = beforeText + tag.en + afterText;

                                // 更新输入框内容并添加高亮效果
                                this.updateInputWithHighlight(widget, newValue);

                                // 更新光标位置
                                const newPos = cursorPos + tag.en.length;
                                widget.inputEl.setSelectionRange(newPos, newPos);

                                // 保持焦点在输入框
                                widget.inputEl.focus();
                            }
                        };

                        // 调用标签管理器显示弹窗
                        TagManager.showTagPopup(enhancedOptions);
                    };

                    // 使用统一的弹窗按钮点击处理
                    UIToolkit.handlePopupButtonClick(
                        e,
                        widget,
                        'tag',
                        showTagPopup,
                        TagManager.hideTagPopup.bind(TagManager)
                    );
                },
                visible: !isNoteNode && FEATURES.tag // Note节点不显示此按钮
            },
            {
                id: 'expand',
                title: '提示词优化',
                icon: 'icon-expand',
                onClick: async (e, widget) => {
                    logger.debug('按钮点击 | 动作: 提示词优化');

                    // 如果按钮处于 processing 状态且被点击，直接返回，
                    // 让UIToolkit中的取消逻辑接管
                    if (e.currentTarget.classList.contains('button-processing')) {
                        return;
                    }

                    await UIToolkit.handleAsyncButtonOperation(
                        widget,
                        'expand',
                        e.currentTarget,
                        async (notifyCancelReady) => {
                            try {
                                // 获取输入值 - 使用统一的getInputValue函数
                                const inputValue = getInputValue(widget);
                                logger.debug(`[提示词优化] 获取到的输入值长度: ${inputValue?.length || 0}`);

                                if (!inputValue || inputValue.trim() === '') {
                                    throw new Error('请输入要优化的提示词');
                                }

                                // 生成唯一request_id
                                const request_id = APIService.generateRequestId('exp', null, widget.nodeId);

                                // 通知UI可以准备取消操作了
                                notifyCancelReady(request_id);

                                // 根据开关选择流式或阻塞式 API
                                let result;
                                let streamContent = '';

                                if (FEATURES.enableStreaming !== false) {
                                    // 显示流式优化中提示
                                    const btnRect = e.currentTarget.getBoundingClientRect();
                                    UIToolkit.showStatusTip(
                                        e.currentTarget,
                                        'loading',
                                        '提示词优化中',
                                        { x: btnRect.left + btnRect.width / 2, y: btnRect.top }
                                    );

                                    result = await APIService.llmExpandPromptStream(
                                        inputValue,
                                        request_id,
                                        (chunk) => {
                                            // 流式回调：实时更新输入框内容
                                            streamContent += chunk;
                                            // 使用 setInputValue 更新输入框（不触发事件，避免频繁抖动）
                                            setInputValue(widget, streamContent, { silent: true });
                                        }
                                    );
                                } else {
                                    // 显示阻塞式优化中提示
                                    const btnRect = e.currentTarget.getBoundingClientRect();
                                    UIToolkit.showStatusTip(
                                        e.currentTarget,
                                        'loading',
                                        '提示词优化中',
                                        { x: btnRect.left + btnRect.width / 2, y: btnRect.top }
                                    );

                                    result = await APIService.llmExpandPrompt(inputValue, request_id);
                                }

                                // 流式完成后，获取最终内容
                                const finalContent = streamContent || result?.data?.expanded || '';

                                if (result && result.success && finalContent) {
                                    // 最终更新（触发事件和高亮）
                                    this.updateInputWithHighlight(widget, finalContent);

                                    // 添加扩写结果到历史记录（只记录最终结果）
                                    HistoryCacheService.addHistory({
                                        workflow_id: widget.nodeInfo?.workflow_id || '',
                                        node_id: widget.nodeId,
                                        input_id: widget.inputId,
                                        content: finalContent,
                                        operation_type: 'expand',
                                        request_id: request_id,
                                        timestamp: Date.now()
                                    });

                                    // 重置撤销状态
                                    HistoryCacheService.initUndoState(widget.nodeId, widget.inputId, finalContent);

                                    // 更新按钮状态
                                    UIToolkit.updateUndoRedoButtonState(widget, HistoryCacheService);

                                    return {
                                        success: true,
                                        useCache: false,
                                        tipType: 'success',
                                        tipMessage: '提示词优化完成'
                                    };
                                } else {
                                    // 不在这里显示错误提示，直接抛出错误让 handleAsyncButtonOperation 处理
                                    throw new Error(result?.error || '扩写失败');
                                }
                            } catch (error) {
                                // 不在这里显示错误提示，直接抛出错误让 handleAsyncButtonOperation 处理
                                throw error;
                            }
                        }
                    );
                },
                visible: !isNoteNode && FEATURES.expand, // Note节点不显示此按钮
                // 添加右键菜单配置
                contextMenu: async (widget) => {
                    // 获取服务列表和当前激活状态
                    let services = [];
                    let currentLLMService = null;
                    let currentLLMModel = null;

                    // 获取扩写规则
                    let activePromptId = null;
                    let expandPrompts = [];

                    try {
                        // 获取服务列表
                        const servicesResp = await fetch(APIService.getApiUrl('/services'));
                        if (servicesResp.ok) {
                            const servicesData = await servicesResp.json();
                            if (servicesData.success) {
                                services = servicesData.services || [];
                            }
                        }

                        // 获取当前激活的LLM服务和模型
                        const llmResp = await fetch(APIService.getApiUrl('/config/llm'));
                        if (llmResp.ok) {
                            const llmConfig = await llmResp.json();
                            currentLLMService = llmConfig.provider || null;
                            currentLLMModel = llmConfig.model || null;
                        }

                        // 获取扩写规则
                        const response = await fetch(APIService.getApiUrl('/config/system_prompts'));
                        if (response.ok) {
                            const data = await response.json();
                            activePromptId = data.active_prompts?.expand || null;

                            if (data.expand_prompts) {
                                const originalOrder = Object.keys(data.expand_prompts);
                                originalOrder.forEach(key => {
                                    const prompt = data.expand_prompts[key];
                                    const showIn = prompt.showIn || ['frontend', 'node'];

                                    // 仅当配置包含 'frontend' 时才在前端菜单显示
                                    if (showIn.includes('frontend')) {
                                        expandPrompts.push({
                                            id: key,
                                            name: prompt.name || key,
                                            category: prompt.category || '',
                                            content: prompt.content,
                                            showIn: showIn,
                                            isActive: key === activePromptId
                                        });
                                    }
                                });
                                expandPrompts.sort((a, b) =>
                                    originalOrder.indexOf(a.id) - originalOrder.indexOf(b.id)
                                );
                            }
                        }
                    } catch (error) {
                        logger.error(`获取提示词优化配置失败: ${error.message}`);
                    }

                    // 创建服务菜单项(只显示有LLM模型的服务,不包括百度)
                    const serviceMenuItems = services
                        .filter(service => service.llm_models && service.llm_models.length > 0)
                        .map(service => {
                            const isCurrentService = currentLLMService === service.id;

                            // 创建模型子菜单
                            const modelChildren = (service.llm_models || []).map(model => {
                                const isCurrentModel = isCurrentService && currentLLMModel === model.name;
                                return {
                                    label: model.display_name || model.name,
                                    icon: `<span class="pi ${isCurrentModel ? 'pi-check-circle active-status' : 'pi-circle-off inactive-status'}"></span>`,
                                    onClick: async (context) => {
                                        try {
                                            const res = await fetch(APIService.getApiUrl('/services/current'), {
                                                method: 'POST',
                                                headers: { 'Content-Type': 'application/json' },
                                                body: JSON.stringify({ service_type: 'llm', service_id: service.id, model_name: model.name })
                                            });
                                            if (!res.ok) throw new Error(`服务器返回错误: ${res.status}`);
                                            const modelLabel = model.display_name || model.name;
                                            UIToolkit.showStatusTip(context.buttonElement, 'success', `${tUI('已切换到: ')}${service.name} - ${modelLabel}`);
                                            logger.log(`提示词优化服务切换 | 服务: ${service.name} | 模型: ${modelLabel}`);
                                        } catch (err) {
                                            logger.error(`切换提示词优化模型失败: ${err.message}`);
                                            UIToolkit.showStatusTip(context.buttonElement, 'error', `${tUI('切换失败: ')}${err.message}`);
                                        }
                                    }
                                };
                            });

                            return {
                                label: service.name || service.id,
                                icon: `<span class="pi ${isCurrentService ? 'pi-check-circle active-status' : 'pi-circle-off inactive-status'}"></span>`,
                                onClick: async (context) => {
                                    try {
                                        const res = await fetch(APIService.getApiUrl('/services/current'), {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ service_type: 'llm', service_id: service.id })
                                        });
                                        if (!res.ok) throw new Error(`服务器返回错误: ${res.status}`);
                                        UIToolkit.showStatusTip(context.buttonElement, 'success', `${tUI('已切换到: ')}${service.name}`);
                                        logger.log(`提示词优化服务切换 | 服务: ${service.name}`);
                                    } catch (err) {
                                        logger.error(`切换提示词优化服务失败: ${err.message}`);
                                        UIToolkit.showStatusTip(context.buttonElement, 'error', `${tUI('切换失败: ')}${err.message}`);
                                    }
                                },
                                children: modelChildren.length > 0 ? modelChildren : undefined
                            };
                        });

                    // ---创建规则菜单项（支持分类分组）---
                    const ruleMenuItems = [];

                    // 辅助函数：创建单个规则菜单项
                    const createRuleMenuItem = (prompt) => ({
                        label: prompt.name,
                        icon: `<span class="pi ${prompt.isActive ? 'pi-check-circle active-status' : 'pi-circle-off inactive-status'}"></span>`,
                        onClick: async (context) => {
                            logger.log(`右键菜单 | 动作: 切换提示词优化 | ID: ${prompt.id}`);
                            try {
                                const response = await fetch(APIService.getApiUrl('/config/active_prompt'), {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ type: 'expand', prompt_id: prompt.id })
                                });
                                if (response.ok) {
                                    UIToolkit.showStatusTip(context.buttonElement, 'success', `${tUI('已切换到: ')}${prompt.name}`);
                                } else {
                                    throw new Error(`服务器返回错误: ${response.status}`);
                                }
                            } catch (error) {
                                logger.error(`切换提示词优化失败: ${error.message}`);
                                UIToolkit.showStatusTip(context.buttonElement, 'error', `${tUI('切换失败: ')}${error.message}`);
                            }
                        }
                    });

                    // 按分类分组规则
                    const uncategorizedPrompts = expandPrompts.filter(p => !p.category);
                    const categorizedPrompts = expandPrompts.filter(p => p.category);

                    // 收集所有分类并排序
                    const categories = [...new Set(categorizedPrompts.map(p => p.category))].sort();

                    // 添加无分类的规则（放在顶层）
                    uncategorizedPrompts.forEach(prompt => {
                        ruleMenuItems.push(createRuleMenuItem(prompt));
                    });

                    // 添加分类分组（每个分类作为二级菜单）
                    categories.forEach(category => {
                        const promptsInCategory = categorizedPrompts.filter(p => p.category === category);
                        const hasActivePrompt = promptsInCategory.some(p => p.isActive);

                        ruleMenuItems.push({
                            label: category,
                            icon: `<span class="pi ${hasActivePrompt ? 'pi-folder-open' : 'pi-folder'}"></span>`,
                            submenuAlign: 'center',
                            children: promptsInCategory.map(prompt => createRuleMenuItem(prompt))
                        });
                    });


                    // 添加规则管理选项
                    ruleMenuItems.push({ type: 'separator' });
                    ruleMenuItems.push({
                        label: '规则管理',
                        icon: '<span class="pi pi-pen-to-square"></span>',
                        onClick: () => {
                            rulesConfigManager.showRulesConfigModal();
                        }
                    });

                    return [
                        ...ruleMenuItems,
                        // { type: 'separator' },
                        {
                            label: "选择服务",
                            icon: '<span class="pi pi-sparkles"></span>',
                            submenuAlign: 'bottom',
                            children: serviceMenuItems
                        }
                    ];
                }
            },
            {
                id: 'translate',
                title: '翻译',
                icon: 'icon-translate',
                onClick: async (e, widget) => {
                    logger.debug('按钮点击 | 动作: 翻译');

                    // 如果按钮处于 processing 状态且被点击，直接返回，
                    // 让UIToolkit中的取消逻辑接管
                    if (e.currentTarget.classList.contains('button-processing')) {
                        return;
                    }

                    await UIToolkit.handleAsyncButtonOperation(
                        widget,
                        'translate',
                        e.currentTarget,
                        async (notifyCancelReady) => {
                            try {
                                // --- Markdown LiteGraph 模式处理 ---
                                // 增强判断逻辑：除了检查nodeType，也检查DOM类名
                                const hasMarkdownClass = widget.inputEl?.classList?.contains('comfy-markdown');
                                const isMarkdownLiteGraph = (widget.nodeInfo?.nodeType === 'MarkdownNote' || hasMarkdownClass) &&
                                    widget.nodeInfo?.isVueMode !== true;

                                logger.debug(`[翻译调试] Markdown检测: ${isMarkdownLiteGraph} (Type: ${widget.nodeInfo?.nodeType}, HasClass: ${hasMarkdownClass})`);

                                // 获取输入值 - 根据模式决定是否获取HTML
                                const inputValue = getInputValue(widget, { html: isMarkdownLiteGraph });

                                if (!inputValue || inputValue.trim() === '') {
                                    throw new Error('请输入要翻译的内容');
                                }

                                let contentToTranslate = inputValue;
                                let mdData = null;

                                if (isMarkdownLiteGraph) {
                                    mdData = MarkdownNoteTranslate.protectAndExtract(inputValue);
                                    if (mdData.texts && mdData.texts.length > 0) {
                                        contentToTranslate = mdData.texts.join('\n');
                                    } else {
                                        // 如果提取后没有文本（只有标签/代码），则认为空或者无需翻译
                                        if (!contentToTranslate || contentToTranslate.trim() === '') {
                                            // 保持原样或抛出错误，这里选择抛出提示
                                            throw new Error('没有检测到可翻译的内容');
                                        }
                                        // 如果原内容有东西但提取为空，可能全是代码块，保留原内容作为待翻译（实际上API可能跳过）
                                        // 或者这里 contentToTranslate 为 inputValue ?
                                        // 不，protectAndExtract 没提取到，说明不该翻译。
                                        // 但为了流程继续，如果不抛错，我们假设 contentToTranslate 为空导致后续报错
                                    }
                                }

                                if (!contentToTranslate || contentToTranslate.trim() === '') {
                                    throw new Error('请输入要翻译的内容');
                                }

                                // 显示翻译中提示
                                const btnRect = e.currentTarget.getBoundingClientRect();
                                UIToolkit.showStatusTip(
                                    e.currentTarget,
                                    'loading',
                                    '翻译中',
                                    { x: btnRect.left + btnRect.width / 2, y: btnRect.top }
                                );

                                // 1. 查询缓存
                                let cacheResult = null;
                                if (FEATURES.useTranslateCache) {
                                    cacheResult = TranslateCacheService.queryTranslateCache(contentToTranslate);
                                }

                                if (cacheResult) {
                                    let rawResultText = '';
                                    let tipMessage = '';
                                    let useCache = true;

                                    // 根据缓存匹配类型处理
                                    if (cacheResult.type === 'source') {
                                        // 命中原文，返回译文
                                        rawResultText = cacheResult.translatedText;
                                        tipMessage = '译文';
                                    } else if (cacheResult.type === 'translated') {
                                        // 命中译文，返回原文
                                        rawResultText = cacheResult.sourceText;
                                        tipMessage = '原文';
                                    }

                                    // 处理 Markdown 格式还原
                                    let finalResultText = rawResultText;
                                    if (isMarkdownLiteGraph && mdData) {
                                        const translatedSegments = rawResultText.split('\n');
                                        finalResultText = MarkdownNoteTranslate.restoreWithTranslations(mdData.placeholderHTML, mdData.placeholders, translatedSegments);
                                    }

                                    // 更新输入框内容并添加高亮效果
                                    this.updateInputWithHighlight(widget, finalResultText, { html: isMarkdownLiteGraph });

                                    // 添加翻译结果到历史记录
                                    HistoryCacheService.addHistory({
                                        workflow_id: widget.nodeInfo?.workflow_id || '',
                                        node_id: widget.nodeId,
                                        input_id: widget.inputId,
                                        content: finalResultText,
                                        operation_type: 'translate',
                                        timestamp: Date.now()
                                    });

                                    // 重置撤销状态
                                    HistoryCacheService.initUndoState(widget.nodeId, widget.inputId, finalResultText);

                                    // 更新按钮状态
                                    UIToolkit.updateUndoRedoButtonState(widget, HistoryCacheService);

                                    return {
                                        success: true,
                                        useCache: useCache,
                                        tipType: 'info',
                                        tipMessage: tipMessage,
                                        buttonElement: e.currentTarget // 传递按钮元素
                                    };
                                }

                                // 缓存未命中，使用API翻译

                                // 生成唯一request_id
                                const request_id = APIService.generateRequestId('trans', null, widget.nodeId);

                                // 通知UI可以准备取消操作了
                                notifyCancelReady(request_id);

                                // 检测语言 (使用提取后的文本)
                                const langResult = PromptFormatter.detectLanguage(contentToTranslate);

                                // 获取翻译服务配置
                                let result;
                                let streamContent = '';  // 用于流式收集内容
                                try {
                                    // 获取翻译配置
                                    const configResp = await fetch(APIService.getApiUrl('/config/translate'));
                                    let isBaidu = false;

                                    if (configResp.ok) {
                                        const config = await configResp.json();
                                        // 检查provider是否为'baidu'
                                        if (config.provider === 'baidu') {
                                            isBaidu = true;
                                        }
                                    }

                                    if (isBaidu) {
                                        // 百度翻译不支持流式，使用原有接口（自动降级）
                                        result = await APIService.baiduTranslate(
                                            contentToTranslate,
                                            langResult.from,
                                            langResult.to,
                                            request_id
                                        );
                                    } else if (FEATURES.enableStreaming !== false) {
                                        // ---流式输出：LLM翻译使用流式 API---
                                        result = await APIService.llmTranslateStream(
                                            contentToTranslate,
                                            langResult.from,
                                            langResult.to,
                                            request_id,
                                            (chunk) => {
                                                // 流式回调：实时更新输入框内容
                                                streamContent += chunk;
                                                // 使用 silent 模式更新，避免频繁触发事件
                                                setInputValue(widget, streamContent, { silent: true, html: isMarkdownLiteGraph });
                                            }
                                        );
                                    } else {
                                        // ---阻塞输出：LLM翻译使用普通 API---
                                        result = await APIService.llmTranslate(
                                            contentToTranslate,
                                            langResult.from,
                                            langResult.to,
                                            request_id
                                        );
                                    }

                                    if (!result) {
                                        throw new Error('翻译服务返回空结果');
                                    }
                                } catch (error) {
                                    logger.error(`翻译失败 | 错误:${error.message}`);
                                    throw new Error(`翻译失败: ${error.message}`);
                                }

                                if (result.success) {
                                    // 格式化翻译结果（优先使用流式收集的内容，否则使用API返回的内容）
                                    const rawTranslated = streamContent || result.data?.translated || '';
                                    const formattedText = PromptFormatter.formatTranslatedText(rawTranslated);

                                    // 处理 Markdown 格式还原
                                    let finalResultText = formattedText;
                                    if (isMarkdownLiteGraph && mdData) {
                                        const translatedSegments = formattedText.split('\n');
                                        finalResultText = MarkdownNoteTranslate.restoreWithTranslations(mdData.placeholderHTML, mdData.placeholders, translatedSegments);
                                    }

                                    // 添加翻译结果到历史记录
                                    HistoryCacheService.addHistory({
                                        workflow_id: widget.nodeInfo?.workflow_id || '',
                                        node_id: widget.nodeId,
                                        input_id: widget.inputId,
                                        content: finalResultText,
                                        operation_type: 'translate',
                                        request_id: request_id,
                                        timestamp: Date.now()
                                    });

                                    // 更新输入框内容并添加高亮效果
                                    this.updateInputWithHighlight(widget, finalResultText, { html: isMarkdownLiteGraph });

                                    // 重置撤销状态
                                    HistoryCacheService.initUndoState(widget.nodeId, widget.inputId, finalResultText);

                                    // 更新按钮状态
                                    UIToolkit.updateUndoRedoButtonState(widget, HistoryCacheService);

                                    // 只有开启缓存时才写入缓存 (使用提取文本和翻译后的片段文本，以便下次能复用)
                                    if (FEATURES.useTranslateCache) {
                                        // 检查是否是混合语言
                                        const isMixedLang = PromptFormatter.isMixedChineseEnglish(contentToTranslate);

                                        // 只有当不是混合语言，或者用户允许缓存混合语言时才写入缓存
                                        if (!isMixedLang || FEATURES.cacheMixedLangTranslation) {
                                            TranslateCacheService.addTranslateCache(contentToTranslate, formattedText);
                                        } else {
                                            logger.debug(`翻译缓存 | 跳过:混合语言内容`);
                                        }
                                    }

                                    return {
                                        success: true,
                                        useCache: false,
                                        tipType: 'success',
                                        tipMessage: '翻译完成'
                                    };
                                } else {
                                    // 不在这里显示错误提示，直接抛出错误让 handleAsyncButtonOperation 处理
                                    throw new Error(result.error);
                                }
                            } catch (error) {
                                // 不在这里显示错误提示，直接抛出错误让 handleAsyncButtonOperation 处理
                                throw error;
                            }
                        }
                    );
                },
                visible: FEATURES.translate, // Note节点只显示此按钮
                // 添加右键菜单配置
                contextMenu: async (widget) => {
                    const useTranslateCache = app.ui.settings.getSettingValue("PromptAssistant.Features.UseTranslateCache");

                    // 获取所有服务列表和当前激活状态
                    let services = [];
                    let currentTranslateService = null;
                    let currentTranslateModel = null;

                    try {
                        // 获取服务列表
                        const servicesResp = await fetch(APIService.getApiUrl('/services'));
                        if (servicesResp.ok) {
                            const servicesData = await servicesResp.json();
                            if (servicesData.success) {
                                services = servicesData.services || [];
                            }
                        }

                        // 获取当前激活的翻译服务和模型
                        const translateResp = await fetch(APIService.getApiUrl('/config/translate'));
                        if (translateResp.ok) {
                            const translateConfig = await translateResp.json();
                            currentTranslateService = translateConfig.provider || null;
                            currentTranslateModel = translateConfig.model || null;
                        }
                    } catch (e) {
                        logger.error(`获取服务列表失败: ${e.message}`);
                    }

                    // 创建服务菜单项
                    const serviceMenuItems = [];

                    // 百度翻译项（永远显示在第一位）
                    const isBaiduCurrent = currentTranslateService === 'baidu';
                    serviceMenuItems.push({
                        label: '百度翻译',
                        icon: `<span class="pi ${isBaiduCurrent ? 'pi-check-circle active-status' : 'pi-circle-off inactive-status'}"></span>`,
                        onClick: async (context) => {
                            try {
                                const res = await fetch(APIService.getApiUrl('/services/current'), {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ service_type: 'translate', service_id: 'baidu' })
                                });
                                if (!res.ok) throw new Error(`服务器返回错误: ${res.status}`);
                                UIToolkit.showStatusTip(context.buttonElement, 'success', `${tUI('已切换到: ')}${tUI('百度翻译')}`);
                                logger.log(`翻译服务切换 | 服务: 百度翻译`);

                                // 派发全局事件通知其他组件同步
                                window.dispatchEvent(new CustomEvent('pa-service-changed', {
                                    detail: { service_type: 'translate', service_id: 'baidu' }
                                }));
                            } catch (err) {
                                logger.error(`切换翻译服务失败: ${err.message}`);
                                UIToolkit.showStatusTip(context.buttonElement, 'error', `${tUI('切换失败: ')}${err.message}`);
                            }
                        }
                    });

                    // 动态添加其他LLM服务
                    const otherServiceMenuItems = services
                        .filter(service => service.llm_models && service.llm_models.length > 0)
                        .map(service => {
                            const isCurrentService = currentTranslateService === service.id;

                            // 创建模型子菜单
                            const modelChildren = (service.llm_models || []).map(model => {
                                const isCurrentModel = isCurrentService && currentTranslateModel === model.name;
                                return {
                                    label: model.display_name || model.name,
                                    icon: `<span class="pi ${isCurrentModel ? 'pi-check-circle active-status' : 'pi-circle-off inactive-status'}"></span>`,
                                    onClick: async (context) => {
                                        try {
                                            const res = await fetch(APIService.getApiUrl('/services/current'), {
                                                method: 'POST',
                                                headers: { 'Content-Type': 'application/json' },
                                                body: JSON.stringify({ service_type: 'translate', service_id: service.id, model_name: model.name })
                                            });
                                            if (!res.ok) throw new Error(`服务器返回错误: ${res.status}`);
                                            const modelLabel = model.display_name || model.name;
                                            UIToolkit.showStatusTip(context.buttonElement, 'success', `${tUI('已切换到: ')}${service.name} - ${modelLabel}`);
                                            logger.log(`翻译服务切换 | 服务: ${service.name} | 模型: ${modelLabel}`);

                                            // 派发全局事件通知其他组件同步
                                            window.dispatchEvent(new CustomEvent('pa-service-changed', {
                                                detail: { service_type: 'translate', service_id: service.id, model_name: model.name }
                                            }));
                                        } catch (err) {
                                            logger.error(`切换翻译模型失败: ${err.message}`);
                                            UIToolkit.showStatusTip(context.buttonElement, 'error', `${tUI('切换失败: ')}${err.message}`);
                                        }
                                    }
                                };
                            });

                            return {
                                label: service.name || service.id,
                                icon: `<span class="pi ${isCurrentService ? 'pi-check-circle active-status' : 'pi-circle-off inactive-status'}"></span>`,
                                onClick: async (context) => {
                                    try {
                                        const res = await fetch(APIService.getApiUrl('/services/current'), {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ service_type: 'translate', service_id: service.id })
                                        });
                                        if (!res.ok) throw new Error(`服务器返回错误: ${res.status}`);
                                        UIToolkit.showStatusTip(context.buttonElement, 'success', `${tUI('已切换到: ')}${service.name}`);
                                        logger.log(`翻译服务切换 | 服务: ${service.name}`);

                                        // 派发全局事件通知其他组件同步
                                        window.dispatchEvent(new CustomEvent('pa-service-changed', {
                                            detail: { service_type: 'translate', service_id: service.id }
                                        }));
                                    } catch (err) {
                                        logger.error(`切换翻译服务失败: ${err.message}`);
                                        UIToolkit.showStatusTip(context.buttonElement, 'error', `${tUI('切换失败: ')}${err.message}`);
                                    }
                                },
                                children: modelChildren.length > 0 ? modelChildren : undefined
                            };
                        });

                    // 将其他服务添加到serviceMenuItems
                    serviceMenuItems.push(...otherServiceMenuItems);

                    return [
                        {
                            label: "选择服务",
                            icon: '<span class="pi pi-sparkles"></span>',
                            children: serviceMenuItems
                        },
                        { type: 'separator' },
                        {
                            label: "翻译缓存",
                            icon: `<span class="pi ${useTranslateCache ? 'pi-check-circle active-status' : 'pi-circle-off inactive-status'}"></span>`,
                            onClick: (context) => {
                                const newStatus = !useTranslateCache;
                                app.ui.settings.setSettingValue("PromptAssistant.Features.UseTranslateCache", newStatus);
                                const statusText = newStatus ? '已开启' : '已关闭';
                                logger.log(`右键菜单 | 动作: 切换翻译缓存 | 状态: ${statusText}`);
                                UIToolkit.showStatusTip(context.buttonElement, 'success', `${tUI('翻译缓存')}${statusText}`);
                            }
                        }
                    ];
                }
            },
        ];

        // 记录添加的按钮
        let historyButtons = [];
        let otherButtons = [];
        let divider = null;

        // ---Add buttons to AssistantContainer---
        for (const config of buttonConfigs) {
            if (config.type === 'divider') {
                // Check visibility for divider
                if (config.visible === false) continue;

                const divider = document.createElement('div');
                divider.className = 'prompt-assistant-divider';
                // Add divider to container
                widget.container.addButton(divider, config.id || `divider_${Date.now()}`);
                // Save reference if needed
                if (config.id) widget.buttons[config.id] = divider;
                continue;
            }

            // Check visibility
            if (config.visible === false) continue;

            // Create button using existing helper
            // Note: addButtonWithIcon returns the button element and saves it to widget.buttons
            const button = this.addButtonWithIcon(widget, config);
            if (!button) continue;

            // Set initial state
            if (config.initialState) {
                Object.entries(config.initialState).forEach(([stateType, value]) => {
                    UIToolkit.setButtonState(widget, config.id, stateType, value);
                });
            }

            // Add to container
            widget.container.addButton(button, config.id);
        }


    }

    /**
     * 添加带图标的按钮
     */
    addButtonWithIcon(widget, config) {
        if (!widget?.element || !widget?.innerContent) return null;

        const { id, title, icon, onClick, contextMenu } = config;

        // 创建按钮
        const button = document.createElement('button');
        button.className = 'prompt-assistant-button';
        button.title = title || '';
        button.dataset.id = id || `btn_${Date.now()}`;

        // 添加图标 - 使用UIToolkit的SVG图标方法
        if (icon) {
            UIToolkit.addIconToButton(button, icon, title || '');
        }

        // 添加事件
        if (typeof onClick === 'function') {
            button.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();

                // 如果按钮被禁用，不执行操作
                if (button.classList.contains('button-disabled')) {
                    return;
                }

                // 执行点击回调
                onClick(e, widget);
            });
        }

        // 添加右键菜单（如果有）
        if (contextMenu && typeof contextMenu === 'function') {
            this._setupButtonContextMenu(button, contextMenu, widget);
        }

        // 保存引用
        if (id) {
            widget.buttons[id] = button;
        }

        return button;
    }

    /**
     * 检测输入框是否有滚动条
     * @param {HTMLElement} inputEl - 输入框元素
     * @returns {boolean} 是否有垂直滚动条
     */
    _detectScrollbar(inputEl) {
        if (!inputEl || inputEl.tagName !== 'TEXTAREA') {
            return false;
        }

        try {
            // 检查垂直滚动条：scrollHeight > clientHeight
            const hasVerticalScrollbar = inputEl.scrollHeight > inputEl.clientHeight;
            // 日志简化：详细滚动条检测日志移至 _adjustPositionForScrollbar，并仅在状态变更时输出
            return hasVerticalScrollbar;
        } catch (error) {
            logger.error(`[滚动条检测] 检测失败 | 错误: ${error.message}`);
            return false;
        }
    }

    /**
     * 根据滚动条状态调整小助手位置
     * @param {Object} widget - 小助手实例
     * @param {HTMLElement} inputEl - 输入框元素
     * @param {Boolean} forceUpdate - 是否强制更新（用于初始化）
     */
    _adjustPositionForScrollbar(widget, inputEl, forceUpdate = false) {
        if (!widget?.element || !inputEl) return;

        const hasScrollbar = this._detectScrollbar(inputEl);
        const containerDiv = widget.element;

        // 仅在滚动条状态发生变化时更新位置（除非强制更新）
        const prevState = containerDiv.dataset.hasScrollbar === 'true';
        if (!forceUpdate && prevState === hasScrollbar) {
            return; // 状态未变，不做任何操作
        }

        // 【关键修复】在位置/布局调整前，显式移除输入框的高亮状态
        // 防止浏览器在重排（Relayout）过程中产生动画残留
        UIToolkit.removeHighlight(inputEl);

        containerDiv.dataset.hasScrollbar = String(hasScrollbar);

        // 有滚动条时向左偏移，避开滚动条
        const rightOffset = hasScrollbar ? '16px' : '4px';
        containerDiv.style.right = rightOffset;
    }

    /**
     * 设置UI位置
     * 支持 Vue node2.0 和 litegraph.js 两种渲染模式
     * @param {Function} onComplete - 定位完成回调，接收boolean参数，true表示成功，false表示失败
     */
    _setupUIPosition(widget, inputEl, containerDiv, canvasContainerRect, inputWidget, onComplete) {


        // 清理函数列表
        widget._eventCleanupFunctions = widget._eventCleanupFunctions || [];

        // 【关键修复】直接使用 widget.node 而不是通过 app.graph.getNodeById 查找
        // 因为进入子图后 app.graph 已经切换到子图的 graph，无法找到主画布节点
        const node = widget.node;
        if (!node) {
            logger.debug(`[定位] widget.node 不存在 | ID: ${widget.nodeId}`);
            if (onComplete) onComplete(false);
            return;
        }


        // 使用真实的 inputWidget，用于适配 Subgraph 的 PromotedWidgetView 解包
        const widgetObj = inputWidget || {
            inputEl: inputEl,
            element: inputEl,
            name: widget.inputId,
            id: widget.inputId
        };

        // 使用 NodeMountService 进行带重试的容器查找
        // Vue mode下需要更多重试次数和更长间隔
        const isVueMode = typeof LiteGraph !== 'undefined' && LiteGraph.vueNodesMode === true;
        nodeMountService.findMountContainerWithRetry(node, widgetObj, {
            maxRetries: isVueMode ? 5 : 3,
            retryInterval: isVueMode ? 800 : 500
        }).then(containerInfo => {
            if (!containerInfo) {
                // logger.debug(`[定位] 容器查找失败 | 节点ID: ${widget.nodeId}`);
                if (onComplete) onComplete(false);
                return;
            }

            // 根据渲染模式应用不同的定位策略
            if (containerInfo.mode === RENDER_MODE.VUE_NODES) {
                this._applyVueNodesPositioning(widget, containerDiv, containerInfo);
            } else {
                this._applyLitegraphPositioning(widget, containerDiv, containerInfo);
            }

            // 保存渲染模式到widget，用于后续调整
            widget._renderMode = containerInfo.mode;

            // 触发回流确保样式生效
            void containerDiv.offsetWidth;

            // 最终成功日志保持精简
            logger.debug(`[定位] 成功 | ID: ${widget.nodeId} | 模式: ${containerInfo.mode} | 锚点: ${widget.container?.anchorPosition}`);
            if (onComplete) onComplete(true);

        }).catch(error => {
            logger.error(`[定位] 异常 | 节点ID: ${widget.nodeId} | 错误: ${error.message}`);
            if (onComplete) onComplete(false);
        });
    }

    /**
     * Vue node2.0 模式下的定位逻辑
     */
    _applyVueNodesPositioning(widget, containerDiv, containerInfo) {
        let { container, textarea, nodeContainer, isNoteNode } = containerInfo;

        // 【特殊处理】Note节点在Vue mode下可能需要二次查找textarea
        if (!textarea && isNoteNode && nodeContainer) {
            const textareas = nodeContainer.querySelectorAll('textarea');
            if (textareas.length > 0) {
                textarea = textareas[0];
                container = textarea.parentElement;
            } else {
                logger.warn(`[Vue定位] Note节点仍未找到textarea | 节点ID: ${widget.nodeId}`);
            }
        }

        // 定期更新输入框引用及事件绑定
        if (textarea && textarea !== widget.inputEl) {
            widget.inputEl = textarea;
            widget.text_element = textarea;
            if (window.PromptAssistantInputWidgetMap && window.PromptAssistantInputWidgetMap[widget.widgetKey]) {
                window.PromptAssistantInputWidgetMap[widget.widgetKey].inputEl = textarea;
            }

            if (!textarea._promptAssistantBound) {
                textarea._promptAssistantBound = true;
                widget._eventCleanupFunctions = widget._eventCleanupFunctions || [];

                widget._eventCleanupFunctions.push(EventManager.addDOMListener(textarea, 'blur', async () => {
                    HistoryCacheService.addHistory({
                        workflow_id: widget.nodeInfo?.workflow_id || '',
                        node_id: widget.nodeId,
                        input_id: widget.inputId,
                        content: textarea.value,
                        operation_type: 'input',
                        timestamp: Date.now()
                    });
                    HistoryCacheService.initUndoState(widget.nodeId, widget.inputId, textarea.value);
                    UIToolkit.updateUndoRedoButtonState(widget, HistoryCacheService);
                }));

                widget._eventCleanupFunctions.push(EventManager.addDOMListener(textarea, 'input', () => {
                    UIToolkit.updateUndoRedoButtonState(widget, HistoryCacheService);
                    this._adjustPositionForScrollbar(widget, textarea);
                }));

                if (window.ResizeObserver) {
                    const resizeObserver = new ResizeObserver(() => {
                        setTimeout(() => this._adjustPositionForScrollbar(widget, textarea), 10);
                    });
                    resizeObserver.observe(textarea);
                    widget._eventCleanupFunctions.push(() => resizeObserver.disconnect());
                }

                if (!widget._undoStateInitialized) {
                    HistoryCacheService.initUndoState(widget.nodeId, widget.inputId, textarea.value);
                    widget._undoStateInitialized = true;
                }
            }
            UIToolkit.updateUndoRedoButtonState(widget, HistoryCacheService);
        }

        // 防重复挂载检查
        if (textarea && textarea._promptAssistantMounted && textarea._promptAssistantWidgetKey !== widget.widgetKey) {
            this._cleanupRedundantWidget(widget);
            return;
        }

        const existingAssistant = container.querySelector('.assistant-container-common');
        if (existingAssistant && !container.contains(containerDiv)) {
            this._cleanupRedundantWidget(widget);
            return;
        }

        if (textarea) {
            textarea._promptAssistantMounted = true;
            textarea._promptAssistantWidgetKey = widget.widgetKey;
        }

        containerDiv.style.position = 'absolute';
        containerDiv.style.zIndex = '10';
        if (window.getComputedStyle(container).position === 'static') {
            container.style.position = 'relative';
        }

        containerDiv.classList.add('vue-node-mode');
        if (!container.contains(containerDiv)) {
            container.appendChild(containerDiv);
        }

        if (textarea) {
            requestAnimationFrame(() => this._adjustPositionForScrollbar(widget, textarea, true));
            setTimeout(() => this._adjustPositionForScrollbar(widget, textarea, true), 150);
        }
    }

    /**
     * 清理冗余的 Widget 实例（当由于并发原因导致重复创建时）
     * @private
     */
    _cleanupRedundantWidget(widget) {
        if (widget.widgetKey && PromptAssistant.instances.has(widget.widgetKey)) {
            PromptAssistant.instances.delete(widget.widgetKey);
        }
        if (widget.container) {
            widget.container.destroy();
        }
    }

    /**
     * litegraph.js 模式下的定位逻辑
     * 【修复】添加后备事件绑定逻辑，与 Vue mode 保持一致
     */
    _applyLitegraphPositioning(widget, containerDiv, containerInfo) {
        const { container: domWidgetContainer, textarea } = containerInfo;

        // 【关键修复】确保 inputEl 引用正确
        if (textarea && textarea !== widget.inputEl) {
            widget.inputEl = textarea;
            widget.text_element = textarea;

            // 更新全局输入框映射
            if (window.PromptAssistantInputWidgetMap && window.PromptAssistantInputWidgetMap[widget.widgetKey]) {
                window.PromptAssistantInputWidgetMap[widget.widgetKey].inputEl = textarea;
            }

            // logger.debug(`[Litegraph定位] 更新inputEl引用 | 节点ID: ${widget.nodeId}`);
        }

        // 【关键修复】确保事件绑定（与 Vue mode 一致的后备逻辑）
        const inputEl = widget.inputEl || textarea;

        // 使用 widget 级别的 flag 判断
        const isBound = widget._inputEventsBound;

        // 精简定位开始日志
        // logger.debug(`[_setupUIPosition] 开始定位 | 节点ID: ${widget.nodeId}`);
        // logger.debug(`[Litegraph定位] 事件绑定检查 | 节点ID: ${widget.nodeId} | inputEl存在: ${!!inputEl} | isBound: ${isBound}`);

        // 如果没有绑定，则绑定事件
        if (inputEl && !isBound) {
            // 如果是遗留标记，记录日志
            if (inputEl._promptAssistantBound) {
                logger.debug(`[Litegraph定位] 检测到遗留标记，重新绑定 | 节点ID: ${widget.nodeId}`);
            }

            inputEl._promptAssistantBound = true;
            widget._inputEventsBound = true; // 设置标记
            widget._eventCleanupFunctions = widget._eventCleanupFunctions || [];
            // logger.debug(`[Litegraph定位] 开始绑定事件 | 节点ID: ${widget.nodeId}`);

            // 绑定blur事件用于历史记录
            const removeBlurListener = EventManager.addDOMListener(inputEl, 'blur', async () => {
                // logger.debug(`[Litegraph] 历史写入准备 | 原因：失焦事件触发 node_id=${widget.nodeId} input_id=${widget.inputId}`);
                HistoryCacheService.addHistory({
                    workflow_id: widget.nodeInfo?.workflow_id || '',
                    node_id: widget.nodeId,
                    input_id: widget.inputId,
                    content: inputEl.value,
                    operation_type: 'input',
                    timestamp: Date.now()
                });
                // 重置撤销状态
                HistoryCacheService.initUndoState(widget.nodeId, widget.inputId, inputEl.value);
                // 更新按钮状态
                UIToolkit.updateUndoRedoButtonState(widget, HistoryCacheService);
            });
            widget._eventCleanupFunctions.push(removeBlurListener);

            // 绑定input事件用于实时更新按钮状态
            const removeInputListener = EventManager.addDOMListener(inputEl, 'input', () => {
                UIToolkit.updateUndoRedoButtonState(widget, HistoryCacheService);
                this._adjustPositionForScrollbar(widget, inputEl);
            });
            widget._eventCleanupFunctions.push(removeInputListener);

            if (!widget._undoStateInitialized) {
                HistoryCacheService.initUndoState(widget.nodeId, widget.inputId, inputEl.value);
                widget._undoStateInitialized = true;
            }

            UIToolkit.updateUndoRedoButtonState(widget, HistoryCacheService);
            // logger.debug(`[Litegraph定位] 事件绑定完成 | 节点ID: ${widget.nodeId}`);
        } else if (inputEl && inputEl._promptAssistantBound) {
            // 已绑定，只更新按钮状态
            UIToolkit.updateUndoRedoButtonState(widget, HistoryCacheService);
        }

        // 【防重复挂载检查】检查 inputEl 是否已被小助手绑定
        if (inputEl && inputEl._promptAssistantMounted) {
            logger.debug(`[Litegraph定位] 跳过挂载 | 原因: inputEl 已被其他小助手绑定 | 节点ID: ${widget.nodeId}`);
            // 清理当前 widget 实例（因为无法正确挂载）
            if (widget.widgetKey && PromptAssistant.instances.has(widget.widgetKey)) {
                PromptAssistant.instances.delete(widget.widgetKey);
            }
            if (widget.container) {
                widget.container.destroy();
            }
            return;
        }

        // 【防重复挂载检查】检查容器内是否已存在小助手元素
        const existingAssistant = domWidgetContainer.querySelector('.assistant-container-common');
        if (existingAssistant) {
            logger.debug(`[Litegraph定位] 跳过挂载 | 原因: 容器内已存在小助手 | 节点ID: ${widget.nodeId}`);
            // 清理当前 widget 实例（因为无法正确挂载）
            if (widget.widgetKey && PromptAssistant.instances.has(widget.widgetKey)) {
                PromptAssistant.instances.delete(widget.widgetKey);
            }
            if (widget.container) {
                widget.container.destroy();
            }
            return;
        }

        // 在 inputEl 上添加挂载标记
        if (inputEl) {
            inputEl._promptAssistantMounted = true;
            inputEl._promptAssistantWidgetKey = widget.widgetKey;
        }

        // 确保 dom-widget 容器有相对定位
        const containerPosition = window.getComputedStyle(domWidgetContainer).position;
        if (containerPosition === 'static') {
            domWidgetContainer.style.position = 'relative';
        }

        // 标准模式使用绝对定位
        containerDiv.style.position = 'absolute';



        // 直接添加到dom-widget容器
        domWidgetContainer.appendChild(containerDiv);

        // 触发回流，确保样式更新
        void containerDiv.offsetWidth;

        // 挂载完成后检测并调整滚动条位置
        if (inputEl) {
            requestAnimationFrame(() => this._adjustPositionForScrollbar(widget, inputEl, true));
        }
    }

    /**
     * 清理单个实例的资源
     */
    _cleanupInstance(instance, instanceKey, skipRemove = false) {
        try {
            // 检查实例是否有效
            if (!instance) {
                logger.debug(`实例清理 | 结果:跳过 | 实例:${instanceKey || 'unknown'} | 原因:实例不存在`);
                return;
            }

            // 标记实例为已销毁
            instance.isDestroyed = true;

            // 1. 重置所有按钮状态
            if (instance.buttons) {
                Object.keys(instance.buttons).forEach(buttonId => {
                    try {
                        const button = instance.buttons[buttonId];
                        if (button) {
                            // 移除所有状态类
                            button.classList.remove('button-active', 'button-processing', 'button-disabled');
                            // 移除所有事件监听器
                            button.replaceWith(button.cloneNode(true));
                        }
                    } catch (err) {
                        logger.debug(`按钮清理 | 按钮:${buttonId} | 错误:${err.message}`);
                    }
                });
                // 清空按钮引用
                instance.buttons = {};
            }

            // 2. 清理事件监听器
            if (instance.cleanupListeners && typeof instance.cleanupListeners === 'function') {
                try {
                    instance.cleanupListeners();
                } catch (err) {
                    logger.debug(`监听器清理 | 错误:${err.message}`);
                }
            }

            // 3. 清理所有保存的事件清理函数
            if (instance._eventCleanupFunctions && Array.isArray(instance._eventCleanupFunctions)) {
                instance._eventCleanupFunctions.forEach(cleanup => {
                    if (typeof cleanup === 'function') {
                        try {
                            cleanup();
                        } catch (err) {
                            logger.debug(`事件清理 | 错误:${err.message}`);
                        }
                    }
                });
                instance._eventCleanupFunctions = [];
            }

            // 3.5【关键修复】重置 inputEl 上的事件绑定标记
            // 确保模式切换后可以重新绑定事件
            if (instance.inputEl && instance.inputEl._promptAssistantBound) {
                instance.inputEl._promptAssistantBound = false;
            }
            if (instance.text_element && instance.text_element._promptAssistantBound) {
                instance.text_element._promptAssistantBound = false;
            }

            // 3.6【防重复挂载修复】重置 textarea 上的挂载标记
            // 确保清理后可以重新挂载小助手
            if (instance.inputEl && instance.inputEl._promptAssistantMounted) {
                instance.inputEl._promptAssistantMounted = false;
                delete instance.inputEl._promptAssistantWidgetKey;
            }
            if (instance.text_element && instance.text_element._promptAssistantMounted && instance.text_element !== instance.inputEl) {
                instance.text_element._promptAssistantMounted = false;
                delete instance.text_element._promptAssistantWidgetKey;
            }

            // 同时重置 widget 级别的标记
            instance._undoStateInitialized = false;
            instance._inputEventsBound = false; // 重置输入事件绑定标记


            // 4. 从DOM中移除元素
            if (instance.element) {
                try {
                    // 确保在移除元素前清理所有子元素的事件
                    const allButtons = instance.element.querySelectorAll('button');
                    allButtons.forEach(button => {
                        button.replaceWith(button.cloneNode(true));
                    });

                    // 清理指示器元素
                    if (instance.indicator && instance.indicator.parentNode) {
                        instance.indicator.innerHTML = '';
                    }

                    if (instance.element.parentNode) {
                        instance.element.parentNode.removeChild(instance.element);
                    }
                } catch (err) {
                    logger.debug(`DOM元素清理 | 错误:${err.message}`);
                }
            }

            // 5. 清理输入框映射
            if (window.PromptAssistantInputWidgetMap && instanceKey) {
                try {
                    delete window.PromptAssistantInputWidgetMap[instanceKey];
                } catch (err) {
                    logger.debug(`输入框映射清理 | 错误:${err.message}`);
                }
            }

            // 6. 清理弹窗状态
            if (window.FEATURES && window.FEATURES.updateButtonsVisibility) {
                try {
                    window.FEATURES.updateButtonsVisibility();
                } catch (err) {
                    logger.debug(`按钮可见性更新 | 错误:${err.message}`);
                }
            }

            // 7. 从实例集合中移除（除非明确指定跳过）
            if (!skipRemove && instanceKey) {
                try {
                    PromptAssistant.instances.delete(instanceKey);
                } catch (err) {
                    logger.debug(`实例集合清理 | 错误:${err.message}`);
                }
            }

            // 8. 清理实例属性
            try {
                Object.keys(instance).forEach(key => {
                    try {
                        delete instance[key];
                    } catch (err) {
                        logger.debug(`属性清理 | 属性:${key} | 错误:${err.message}`);
                    }
                });
            } catch (err) {
                logger.debug(`属性清理 | 错误:${err.message}`);
            }

            // logger.debug(`实例清理 | 结果:成功 | 实例:${instanceKey || 'unknown'}`);
        } catch (error) {
            logger.error(`实例清理失败 | 实例:${instanceKey || 'unknown'} | 错误:${error.message}`);
        }
    }

    /**
     * 设置按钮右键菜单
     * @param {HTMLElement} button 按钮元素
     * @param {Function} getMenuItems 获取菜单项的函数
     * @param {Object} widget 小助手实例
     */
    _setupButtonContextMenu(button, getMenuItems, widget) {
        if (!button || typeof getMenuItems !== 'function') return;

        // 设置右键菜单
        const cleanup = buttonMenu.setupButtonMenu(button, () => {
            // 调用getMenuItems函数获取菜单项，传入widget作为上下文
            return getMenuItems(widget);
        }, { widget, buttonElement: button });

        // 保存清理函数到widget的事件清理函数列表中
        if (cleanup) {
            widget._eventCleanupFunctions = widget._eventCleanupFunctions || [];
            widget._eventCleanupFunctions.push(cleanup);
        }
    }
}

// 创建单例实例
const promptAssistant = new PromptAssistant();

// 导出
export { promptAssistant, PromptAssistant };
