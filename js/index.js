/**
 * 提示词小助手 (PromptAssistant) 主入口文件
 * 负责扩展初始化、节点检测和功能注入
 */

import { app } from "../../../scripts/app.js";
import { promptAssistant, PromptAssistant } from './modules/PromptAssistant.js';
import { registerSettings } from './modules/settings.js';
import { FEATURES as ASSISTANT_FEATURES, handleFeatureChange, setFeatureModuleDeps } from './services/features.js';
import { EventManager } from './utils/eventManager.js';
import { ResourceManager } from './utils/resourceManager.js';
import { UIToolkit } from "./utils/UIToolkit.js";
import { logger } from './utils/logger.js';
import { HistoryCacheService, TagCacheService } from './services/cache.js';
import { imageCaption, ImageCaption } from './modules/imageCaption.js';

// import { ensureAutoTranslateInterceptorInstalled } from './services/interceptor.js'; // 导入自动翻译拦截器

// ====================== 全局配置与状态 ======================

// 设置全局对象供其他模块访问
window.FEATURES = ASSISTANT_FEATURES;

// 将实例添加到全局对象
window.promptAssistant = promptAssistant;
window.imageCaption = imageCaption;

// 将实例添加到全局app对象
app.promptAssistant = promptAssistant;
app.imageCaption = imageCaption;

// ====================== 扩展注册 ======================

/**
 * 注册ComfyUI扩展
 */
app.registerExtension({
    name: "Comfy.PromptAssistant",

    // ---扩展生命周期钩子---
    /**
     * 初始化扩展
     */
    async setup() {
        try {
            // 注册设置选项
            registerSettings();

            // 初始化自动翻译拦截器（独立于提示词小助手）
            // ensureAutoTranslateInterceptorInstalled();

            // 初始化历史记录服务端同步（失败时自动回退本地存储模式）
            await HistoryCacheService.initServerSync();

            // 初始化提示词小助手（内部会处理版本号检查和总开关状态）
            await promptAssistant.initialize();

            // 初始化图像小助手（只初始化一次）
            if (!imageCaption.initialized) {
                await imageCaption.initialize();
            }

            // 清理旧引用
            if (app.canvas) {
                app.canvas.updateNodeAssistantsVisibility = null;
                app.canvas._onNodeSelectionChange = null;
            }

            // 将管理器添加到app对象，使其可以通过window.app访问
            app.EventManager = EventManager;
            app.ResourceManager = ResourceManager;
            app.UIToolkit = UIToolkit;

            // 先初始化 features.js 依赖
            setFeatureModuleDeps({
                promptAssistant,
                PromptAssistant,
                UIToolkit,
                HistoryCacheService,
                TagCacheService,
                imageCaption,
                ImageCaption
            });

            // 然后再自动注册服务功能
            if (window.FEATURES.enabled) {
                await promptAssistant.toggleGlobalFeature(true, true);
                // 避免重复初始化，只在必要时启用图像小助手功能
                if (window.FEATURES.imageCaption) {
                    await imageCaption.toggleGlobalFeature(true, false);
                }
            }

            logger.log("扩展初始化完成");
        } catch (error) {
            logger.error(`扩展初始化失败: ${error.message}`);
        }

        // 仅保留工作流ID识别功能，不处理工作流切换事件
        try {
            const LGraph = app.graph.constructor;
            const origConfigure = LGraph.prototype.configure;
            LGraph.prototype.configure = function (data) {
                // 在图表对象上存储工作流ID
                this._workflow_id = data.id || LiteGraph.uuidv4();

                // 执行原始方法
                return origConfigure.apply(this, arguments);
            };

            // 添加工作流加载监听，只标记切换状态，不做特殊处理
            const origLoadGraphData = app.loadGraphData;
            app.loadGraphData = async function (data) {
                // 设置工作流切换标记，避免删除缓存
                window.PROMPT_ASSISTANT_WORKFLOW_SWITCHING = true;

                // 简化日志：仅在工作流ID变化时打印一次
                const workflowId = data?.id || (data?.extra?.workflow_id) || "未知工作流";
                if (app.graph?._workflow_id !== workflowId) {
                    logger.log(`[工作流] 切换: ${workflowId}`);
                }

                try {
                    // 调用原始加载方法
                    const result = await origLoadGraphData.apply(this, arguments);
                    return result;
                } finally {
                    // 延迟重置工作流切换标记
                    setTimeout(() => {
                        window.PROMPT_ASSISTANT_WORKFLOW_SWITCHING = false;
                    }, 500);
                }
            };
        } catch (e) {
            logger.error("[PromptAssistant] 注入 LGraph 设置工作流ID失败", e);
        }
    },

    // ---节点生命周期钩子---
    /**
     * 节点创建钩子
     * 在节点创建时初始化特定类型节点的小助手
     */
    async nodeCreated(node) {
        try {
            // 始终检查总开关状态
            if (!window.FEATURES.enabled) {
                return;
            }

            // 只在节点被选中时进行检测和初始化
            if (!node || !node.id || node.id === -1) {
                return;
            }

            // 检查是否为提示词节点
            if (PromptAssistant.isValidNode(node)) {
                if (!node._promptAssistantInitialized) {
                    node._promptAssistantInitialized = true;
                    promptAssistant.checkAndSetupNode(node);
                }
                return;
            }

            // 检查是否为图像节点，同时检查图像反推功能开关
            if (window.FEATURES.imageCaption && imageCaption.hasValidImage(node)) {
                if (!node._imageCaptionInitialized) {
                    node._imageCaptionInitialized = true;
                    imageCaption.checkAndSetupNode(node);
                }
                return;
            }
        } catch (error) {
            logger.error(`节点创建处理失败: ${error.message}`);
        }
    },

    /**
     * 节点移除钩子
     * 在节点被删除时清理对应的小助手实例
     */
    async nodeRemoved(node) {
        // 如果正在切换工作流，则不执行任何清理操作
        if (window.PROMPT_ASSISTANT_WORKFLOW_SWITCHING) {
            return;
        }

        try {
            if (!node || node.id === undefined || node.id === -1) return;

            // 安全获取节点ID，用于日志记录
            const nodeId = node.id;

            // 添加清理标记，避免重复清理
            node._promptAssistantCleaned = false;
            node._imageCaptionCleaned = false;

            // 清理提示词小助手
            if (node._promptAssistantInitialized) {
                promptAssistant.cleanup(nodeId);
                node._promptAssistantCleaned = true;
                logger.debug(`[节点移除钩子] 提示词小助手清理完成 | 节点ID: ${nodeId}`);
            }

            // 清理图像小助手
            if (node._imageCaptionInitialized) {
                imageCaption.cleanup(nodeId);
                node._imageCaptionCleaned = true;
                logger.debug(`[节点移除钩子] 图像小助手清理完成 | 节点ID: ${nodeId}`);
            }
        } catch (error) {
            const safeNodeId = node && node.id !== undefined ? node.id : "unknown";
            logger.error(`[节点移除钩子] 处理失败 | 节点ID: ${safeNodeId} | 错误: ${error.message}`);
        }
    },

    /**
     * 节点定义注册前钩子
     * 向所有节点类型注入小助手相关功能
     */
    async beforeRegisterNodeDef(nodeType, nodeData) {
        // 保存原始方法
        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        const origOnRemoved = nodeType.prototype.onRemoved;
        const origOnSelected = nodeType.prototype.onSelected;

        // 注入节点创建方法
        nodeType.prototype.onNodeCreated = function () {
            if (origOnNodeCreated) {
                origOnNodeCreated.apply(this, arguments);
            }

            // 始终检查最新的总开关状态
            const currentEnabled = app.ui.settings.getSettingValue("PromptAssistant.Features.Enabled");
            window.FEATURES.enabled = currentEnabled !== undefined ? currentEnabled : true;

            // 总开关关闭时，直接返回
            if (!window.FEATURES.enabled) {
                return;
            }

            // 设置未初始化标记，等待nodeCreated钩子处理
            this._promptAssistantInitialized = false;
            this._imageCaptionInitialized = false;
        };

        // 注入节点选择方法
        nodeType.prototype.onSelected = function () {
            if (origOnSelected) {
                origOnSelected.apply(this, arguments);
            }

            // 确保总开关开启
            if (!window.FEATURES.enabled) {
                return;
            }

            // 重置提示词小助手初始化标记，确保每次选择都重新检测节点状态
            this._promptAssistantInitialized = false;
            promptAssistant.checkAndSetupNode(this);

            // 确保选择事件能触发到图像小助手，同时检查图像反推功能开关
            if (window.FEATURES.imageCaption &&
                app.canvas && app.canvas._imageCaptionSelectionHandler) {
                // 重置初始化标记，确保每次选择都重新检测节点状态
                this._imageCaptionInitialized = false;

                const selected_nodes = {};
                selected_nodes[this.id] = this;
                app.canvas._imageCaptionSelectionHandler(selected_nodes);
            }
        };

        // 注入节点移除方法
        nodeType.prototype.onRemoved = function () {
            try {
                // 首先检查this和this.id是否存在和有效
                if (!this) {
                    logger.debug("[onRemoved方法] 节点实例不存在，跳过清理");
                    if (origOnRemoved) {
                        origOnRemoved.apply(this, arguments);
                    }
                    return;
                }

                // 安全获取节点ID，如果不存在则使用占位符
                const nodeId = this.id !== undefined ? this.id : "unknown";

                // 清理提示词小助手（如果尚未清理）
                if (this._promptAssistantInitialized && !this._promptAssistantCleaned) {
                    if (this.id !== undefined) {
                        promptAssistant.cleanup(this.id);
                        this._promptAssistantCleaned = true;
                    }
                }

                // 清理图像小助手（如果尚未清理）
                if (this._imageCaptionInitialized && !this._imageCaptionCleaned) {
                    if (this.id !== undefined) {
                        imageCaption.cleanup(this.id);
                        this._imageCaptionCleaned = true;
                    }
                }

                // 即使没有初始化标记，也尝试清理（关键修复）
                // 这是为了处理可能的边缘情况，确保完全清理
                if (!this._promptAssistantCleaned && this.id !== undefined) {
                    promptAssistant.cleanup(this.id, true);
                }
                if (!this._imageCaptionCleaned && this.id !== undefined) {
                    imageCaption.cleanup(this.id, true);
                }

                // 简化：仅在两者都清理完成时输出一次
                if (this._promptAssistantCleaned && this._imageCaptionCleaned) {
                    logger.log(`[节点清理] 完成 | 节点ID: ${nodeId}`);
                }

                if (origOnRemoved) {
                    origOnRemoved.apply(this, arguments);
                }
            } catch (error) {
                // 安全获取节点ID，用于错误日志
                const safeNodeId = this && this.id !== undefined ? this.id : "unknown";
                logger.error(`[onRemoved方法] 清理失败 | 节点ID: ${safeNodeId} | 错误: ${error.message}`);
                // 确保原始方法仍然被调用
                if (origOnRemoved) {
                    origOnRemoved.apply(this, arguments);
                }
            }
        };
    },

    /**
     * 扩展卸载钩子
     * 在扩展被卸载时清理所有资源
     */
    async beforeExtensionUnload() {
        promptAssistant.cleanup();
        imageCaption.cleanup();
    }
});

export { EventManager, UIToolkit };