/**
 * 图像节点小助手类
 * 用于检测和处理图像节点，提供图像反推功能
 */

import { app } from "../../../../scripts/app.js";
import { logger } from '../utils/logger.js';
import { ResourceManager } from "../utils/resourceManager.js";
import { UIToolkit } from "../utils/UIToolkit.js";
import { EventManager } from "../utils/eventManager.js";
import { APIService } from '../services/api.js';
import { HistoryCacheService } from '../services/cache.js';
import { buttonMenu } from "../services/btnMenu.js";
import { rulesConfigManager } from "./rulesConfigManager.js";
import { nodeMountService, RENDER_MODE } from "../services/NodeMountService.js";
import { AssistantContainer, ANCHOR_POSITION } from "./AssistantContainer.js";
import { PopupManager } from "../utils/popupManager.js";



class ImageCaption {
    /** 存储所有小助手实例的Map集合 */
    static instances = new Map();

    constructor() {
        this.initialized = false;
    }

    /**
     * 获取低画质渲染阈值
     * 将此方法提取为类方法，确保所有地方使用相同的阈值计算逻辑
     */
    _getQualityThreshold() {
        // 优先从系统设置获取
        if (app.ui?.settings) {
            try {
                // 修复：不使用已弃用的defaultValue参数
                const settingValue = app.ui.settings.getSettingValue('Comfy.Graph.CanvasInfo');
                if (typeof settingValue === 'number') {
                    return settingValue;
                }
            } catch (e) {
                // 忽略错误，使用默认值
            }
        }
        // 从canvas对象获取
        return app.canvas?.low_quality_zoom_threshold || 0.6;
    }

    /**
     * 检查节点类型是否是允许的图像节点类型（公开方法）
     */
    isSupportedNode(node) {
        return this._isAllowedNodeType(node);
    }

    /**
     * 检查节点类型是否是允许的图像节点类型
     * @param {object} node - LiteGraph节点对象
     * @param {boolean} debug - 是否打印调试日志
     * @returns {boolean} 是否是允许的节点类型
     */
    _isAllowedNodeType(node, debug = false) {
        if (!node || !node.type) return false;

        // 允许的节点类型列表（可根据实际情况调整）
        const allowedTypes = [
            // 加载图像节点
            'LoadImage',
            'LoadImageFromUrl',

            // 预览图像节点
            'PreviewImage',
            'ImagePreview',

            // 保存图像节点
            'SaveImage',
            'SaveImages'
        ];

        // 检查节点类型是否在允许列表中
        // 使用部分匹配方式，以便兼容不同插件中的类似节点
        const isAllowed = allowedTypes.some(type =>
            node.type.includes(type) ||
            (node.title && node.title.includes(type))
        );

        // 开发阶段可打开调试日志
        if (debug && !isAllowed) {
            logger.debug(`[图像小助手] 节点类型不允许: ${node.type || '未知'} | 标题: ${node.title || '未知'}`);
        }

        return isAllowed;
    }

    /**
     * 检查节点和画布状态是否适合显示小助手
     * @param {object} node - LiteGraph节点对象
     * @returns {object} 返回检测结果对象
     */
    _checkNodeAndCanvasState(node) {
        const result = {
            isValid: false,
            isCollapsed: false,
            isLowQuality: false,
            hasValidImage: false
        };

        if (!node) {
            return result;
        }

        // 检查节点是否是允许的图像节点类型
        if (!this._isAllowedNodeType(node)) {
            return result;
        }

        // 检查节点是否被折叠
        if (node.flags && node.flags.collapsed) {
            result.isCollapsed = true;
            return result;
        }

        // 检查是否处于低质量渲染状态
        if (app.canvas) {
            // 获取低画质渲染阈值
            const threshold = this._getQualityThreshold();
            const scale = app.canvas.ds.scale;

            // 添加一个较大的容差值，解决浮点数比较和阈值应用延迟问题
            const epsilon = 0.001;
            if (scale <= threshold + epsilon) {
                result.isLowQuality = true;
                return result;
            }
        }

        // 检查节点是否有有效图像
        if (node.imgs && Array.isArray(node.imgs) && node.imgs.length > 0) {
            const imageIndex = node.imageIndex || 0;
            if (imageIndex >= 0 && imageIndex < node.imgs.length && node.imgs[imageIndex]) {
                result.hasValidImage = true;
                result.isValid = true;
            }
        }

        // --- 补充检测: Vue Node 2.0 DOM 检测 ---
        if (!result.hasValidImage && nodeMountService.isVueNodesMode()) {
            const nodeContainer = document.querySelector(`[data-node-id="${node.id}"]`);
            if (nodeContainer) {
                const imgElement = nodeContainer.querySelector('img');
                if (imgElement && imgElement.src && !imgElement.src.includes('error')) {
                    // logger.debugSample(() => `[图像小助手] 通过 DOM 检测到图像 | ID: ${node.id}`);
                    result.hasValidImage = true;
                    result.isValid = true;
                }
            }
        }

        return result;
    }

    /**
     * 检查节点是否有有效图像
     * @param {object} node - LiteGraph节点对象
     * @returns {boolean} 是否有有效图像
     */
    hasValidImage(node) {
        if (!node) return false;

        // 检查节点类型是否允许
        if (!this._isAllowedNodeType(node)) {
            return false;
        }

        // 检查节点是否有imgs属性
        if (!node.imgs || !Array.isArray(node.imgs) || node.imgs.length === 0) {
            return false;
        }

        // 获取当前显示的图像
        const imageIndex = node.imageIndex || 0;
        return imageIndex >= 0 && imageIndex < node.imgs.length && node.imgs[imageIndex] != null;
    }

    /**
     * 获取节点当前显示的图像对象
     * @param {object} node - LiteGraph节点对象
     * @returns {object|null} 返回图像对象或null
     */
    getNodeImage(node) {
        // 检查节点类型是否允许
        if (!this._isAllowedNodeType(node)) {
            return null;
        }

        const state = this._checkNodeAndCanvasState(node);

        if (!state.isValid) {
            return null;
        }

        // 返回当前显示的图像
        const imageIndex = node.imageIndex || 0;
        return node.imgs[imageIndex];
    }

    /**
     * 初始化图像小助手
     */
    async initialize() {
        if (this.initialized) return true;

        try {
            // 检查总开关的初始状态
            const initialEnabled = app.ui.settings.getSettingValue("PromptAssistant.Features.ImageCaption");
            window.FEATURES.imageCaption = initialEnabled !== undefined ? initialEnabled : true;

            // 只在调试模式下记录初始化状态
            logger.debug(`图像反推功能初始化 | 状态:${window.FEATURES.imageCaption ? "启用" : "禁用"}`);

            // 注册节点选择监听器
            this.registerNodeSelectionListener();

            // 标记为已初始化
            this.initialized = true;
            logger.log("图像小助手初始化完成");
            return true;
        } catch (error) {
            logger.error(() => `图像小助手初始化失败 | 错误: ${error.message}`);
            this.initialized = false;
            return false;
        }
    }

    /**
     * 注册节点选择事件监听
     */
    registerNodeSelectionListener() {
        if (!app.canvas) {
            logger.error("画布未初始化，无法注册节点选择事件监听器");
            return;
        }

        // 如果已经注册过选择事件处理器，则不再重复注册
        if (app.canvas._imageCaptionSelectionHandler) {
            logger.debug("图像小助手节点选择监听器已存在，跳过注册");
            return;
        }

        // 创建选择事件处理器
        const selectionHandler = (selected_nodes) => {
            // 当总开关或图像反推功能关闭时，跳过所有节点处理
            if (!window.FEATURES || !window.FEATURES.enabled || !window.FEATURES.imageCaption) {
                return;
            }

            // 处理空选择情况
            if (!selected_nodes || Object.keys(selected_nodes).length === 0) {
                return;
            }

            // 处理选中的节点
            for (const nodeId in selected_nodes) {
                const node = app.canvas.graph._nodes_by_id[nodeId];
                if (!node || node.id === -1) continue;

                // 移除初始化标记判断，每次选中都重新检测节点状态
                this.checkAndSetupNode(node);
            }
        };

        // 保存原始的选择事件处理器
        if (app.canvas.onSelectionChange && app.canvas.onSelectionChange !== selectionHandler) {
            app.canvas._originalImageCaptionSelectionChange = app.canvas.onSelectionChange;
        }

        // 设置新的选择事件处理器
        app.canvas._imageCaptionSelectionHandler = selectionHandler;

        // 添加到LiteGraph的事件系统
        if (app.canvas.graph) {
            app.canvas.graph._imageCaptionNodeSelectionChange = selectionHandler;
        }

        logger.debug("图像小助手节点选择监听器注册成功");

        // 初始检查当前选中的节点
        if (app.canvas.selected_nodes && Object.keys(app.canvas.selected_nodes).length > 0) {
            selectionHandler(app.canvas.selected_nodes);
        }
    }

    /**
     * 检查节点并设置小助手
     */
    checkAndSetupNode(node) {
        // 检查总开关和图像反推功能开关状态
        if (!window.FEATURES || !window.FEATURES.enabled || !window.FEATURES.imageCaption) {
            return;
        }

        // 检查节点是否有效
        if (!node) return;

        // 检查节点类型是否允许
        if (!this._isAllowedNodeType(node)) {
            return;
        }

        // 检查节点是否已被删除（只有在删除时才清理实例）
        if (!app.canvas || !app.canvas.graph || !app.canvas.graph._nodes_by_id[node.id]) {
            // 节点已被删除，清理实例
            this.cleanup(node.id);
            return;
        }

        // 检查节点和画布状态
        const nodeState = this._checkNodeAndCanvasState(node);

        // 如果节点折叠或画布缩放过小，隐藏已存在的实例但不创建新实例
        if (nodeState.isCollapsed || nodeState.isLowQuality) {
            if (ImageCaption.hasInstance(node.id)) {
                const instance = ImageCaption.getInstance(node.id);
                if (instance) {
                    this.updateAssistantVisibility(instance);
                }
            }
            return;
        }

        // 验证现有实例是否有效
        const existingInstance = ImageCaption.getInstance(node.id);
        const isElementValid = existingInstance && existingInstance.element && document.body.contains(existingInstance.element);
        const isVueMode = nodeMountService.isVueNodesMode();

        // 在 Vue 模式下，element 可能挂载在节点容器内而不是 body
        const isVueElementValid = isVueMode && existingInstance && existingInstance.element &&
            document.querySelector(`[data-node-id="${node.id}"]`)?.contains(existingInstance.element);

        if (existingInstance && (isElementValid || isVueElementValid)) {
            // 实例有效，更新其显示状态（内部会处理图片检测）
            this.updateAssistantVisibility(existingInstance);
        } else {
            // 实例无效或不存在，清理并强制创建（白名单机制）
            if (existingInstance) {
                this.cleanup(node.id);
            }

            // 创建新的小助手实例
            const assistant = this.setupNodeAssistant(node);
            if (assistant) {
                logger.debug(() => `[图像小助手] 预挂载成功 | ID: ${node.id} | 等待图像加载...`);
            }
        }
    }

    /**
     * 为节点设置小助手
     */
    setupNodeAssistant(node) {
        if (!node) return null;

        // 创建小助手实例
        const assistant = this.createAssistant(node);
        if (assistant) {
            // 初始化显示状态
            this.showAssistantUI(assistant);
            return assistant;
        }
        return null;
    }

    /**
     * 创建小助手实例
     */
    createAssistant(node) {
        // 检查节点是否有效
        if (!node || !node.id || node.id === -1) {
            return null;
        }

        // 检查是否已存在实例
        if (ImageCaption.hasInstance(node.id)) {
            return ImageCaption.getInstance(node.id);
        }

        // 保存 nodeId 用于动态获取节点
        const nodeId = node.id;

        // 创建小助手对象
        const assistant = {
            nodeId: nodeId,
            buttons: {},
            isActive: false,
            isTransitioning: false,
            isDestroyed: false,
            _eventCleanupFunctions: [],
            _timers: {},
            // 保存初始节点引用作为后备（Vue Node 2.0 子图切换场景）
            _initialNode: node
        };

        // 动态获取节点的 getter，避免持有已删除节点的引用
        // 【修复】优先从 graph 获取，失败时回退到初始引用（解决子图切换时画布未同步问题）
        Object.defineProperty(assistant, 'node', {
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

        // 创建UI
        this.createAssistantUI(assistant);

        // 添加到实例集合
        ImageCaption.addInstance(nodeId, assistant);

        // 设置节点折叠状态监听
        this._setupNodeCollapseListener(assistant);

        // 设置画布缩放监听
        this._setupCanvasScaleListener(assistant);

        // 显示小助手
        this.updateAssistantVisibility(assistant);

        return assistant;
    }

    /**
     * 创建小助手UI
     */
    createAssistantUI(assistant) {
        // 【修复】使用 nodeId 作为有效性检查，避免因画布切换时 getter 返回 null 导致创建失败
        if (!assistant?.nodeId) return null;

        try {
            // 获取位置设置
            let locationSetting = app.ui.settings.getSettingValue(
                "ImageCaption.Location"
            );

            // 根据不同的渲染模式自动分配互不冲突的最佳位置
            if (nodeMountService.isVueNodesMode()) {
                locationSetting = ANCHOR_POSITION.BOTTOM_RIGHT_H; // Vue模式右下角避开ID
            } else {
                locationSetting = ANCHOR_POSITION.BOTTOM_LEFT_H; // LiteGraph模式保持左下角
            }

            // Create AssistantContainer instance
            const container = new AssistantContainer({
                nodeId: assistant.nodeId,
                type: 'image', // Uses image-assistant-container class
                anchorPosition: locationSetting,
                enableDragSort: true,
                onButtonOrderChange: (order) => {
                    // Order preservation handled by container
                },
                shouldCollapse: () => {
                    return !this._checkAssistantActiveState(assistant);
                }
            });

            // Render
            const containerEl = container.render();

            // Set Icon
            const mainIcon = ResourceManager.getIcon('icon-main.svg');
            if (mainIcon && container.indicator) {
                container.indicator.innerHTML = '';
                container.indicator.appendChild(mainIcon);
            }

            // Save references
            assistant.container = container;
            assistant.element = containerEl;
            assistant.innerContent = container.content;
            assistant.hoverArea = container.hoverArea;
            assistant.indicator = container.indicator;
            assistant.buttons = {};

            // Sync state properties
            Object.defineProperty(assistant, 'isCollapsed', {
                get: () => container.isCollapsed,
                set: (val) => {
                    if (val) container.collapse(); else container.expand();
                }
            });
            Object.defineProperty(assistant, 'isTransitioning', {
                get: () => container.isTransitioning,
                set: (val) => { container.isTransitioning = val; }
            });

            // Add buttons
            this.addFunctionButtons(assistant);

            // Restore order
            container.restoreOrder();

            // 初始设置
            // 注意：原始代码设置位置固定并追加到 body
            // AssistantContainer 创建元素但不挂载。
            // 原始代码：
            // containerDiv.style.position = 'fixed';
            // document.body.appendChild(containerDiv);

            // 我们遵循原始逻辑，将 Image Assistant 追加到 body
            containerEl.style.position = 'fixed';
            containerEl.style.zIndex = '1';
            document.body.appendChild(containerEl);

            // 延迟设置位置
            // 优化：使用 requestAnimationFrame 确保在下一次重绘前更新位置
            requestAnimationFrame(() => {
                this._setupUIPosition(assistant);
                if (container) container.updateDimensions();
            });

            // 折叠/展开设置由 container 处理
            // 移除手动事件设置

            return containerEl;

        } catch (error) {
            logger.error(`图像小助手UI创建失败 | ID: ${assistant.nodeId} | ${error.message}`);
            return null;
        }
    }

    /**
     * 添加功能按钮
     */
    addFunctionButtons(assistant) {
        if (!assistant?.element) return;

        // 创建反推按钮（中文）
        const buttonZh = this.addButtonWithIcon(assistant, {
            id: 'caption_zh',
            title: '反推提示词（中文）',
            icon: 'icon-caption-zh',
            onClick: async (e, assistant) => {
                e.preventDefault();
                e.stopPropagation();
                await this.handleImageAnalysis(assistant, 'zh');
            },
            // 添加中文反推按钮的右键菜单
            contextMenu: async (assistant) => {
                // 获取服务列表和当前激活状态
                let services = [];
                let currentVLMService = null;
                let currentVLMModel = null;

                // 获取中文反推规则
                let activePromptId = null;
                let visionPrompts = [];

                try {
                    // 获取服务列表
                    const servicesResp = await fetch(APIService.getApiUrl('/services'));
                    if (servicesResp.ok) {
                        const servicesData = await servicesResp.json();
                        if (servicesData.success) {
                            services = servicesData.services || [];
                        }
                    }

                    // 获取当前激活的VLM服务和模型
                    const vlmResp = await fetch(APIService.getApiUrl('/config/vision'));
                    if (vlmResp.ok) {
                        const vlmConfig = await vlmResp.json();
                        currentVLMService = vlmConfig.provider || null;
                        currentVLMModel = vlmConfig.model || null;
                    }

                    // 获取中文反推规则
                    const response = await fetch(APIService.getApiUrl('/config/system_prompts'));
                    if (response.ok) {
                        const data = await response.json();
                        activePromptId = data.active_prompts?.vision_zh || null;

                        if (data.vision_prompts) {
                            const originalOrder = Object.keys(data.vision_prompts);
                            originalOrder.forEach(key => {
                                if (key.startsWith('vision_zh')) {
                                    const prompt = data.vision_prompts[key];
                                    const showIn = prompt.showIn || ['frontend', 'node'];

                                    // 仅当配置包含 'frontend' 时才在前端菜单显示
                                    if (showIn.includes('frontend')) {
                                        visionPrompts.push({
                                            id: key,
                                            name: prompt.name || key,
                                            category: prompt.category || '',
                                            showIn: showIn,
                                            isActive: key === activePromptId
                                        });
                                    }
                                }
                            });
                            visionPrompts.sort((a, b) =>
                                originalOrder.indexOf(a.id) - originalOrder.indexOf(b.id)
                            );
                        }
                    }
                } catch (error) {
                    logger.error(() => `获取中文反推配置失败: ${error.message}`);
                }

                // 创建服务菜单项(只显示有VLM模型的服务)
                const serviceMenuItems = services
                    .filter(service => service.vlm_models && service.vlm_models.length > 0)
                    .map(service => {
                        const isCurrentService = currentVLMService === service.id;

                        // 创建模型子菜单
                        const modelChildren = (service.vlm_models || []).map(model => {
                            const isCurrentModel = isCurrentService && currentVLMModel === model.name;
                            return {
                                label: model.display_name || model.name,
                                icon: `<span class="pi ${isCurrentModel ? 'pi-check-circle active-status' : 'pi-circle-off inactive-status'}"></span>`,
                                onClick: async (context) => {
                                    try {
                                        const res = await fetch(APIService.getApiUrl('/services/current'), {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ service_type: 'vlm', service_id: service.id, model_name: model.name })
                                        });
                                        if (!res.ok) throw new Error(`服务器返回错误: ${res.status}`);
                                        const modelLabel = model.display_name || model.name;
                                        UIToolkit.showStatusTip(context.buttonElement, 'success', `已切换到: ${service.name} - ${modelLabel}`);
                                        logger.log(`视觉服务切换 | 服务: ${service.name} | 模型: ${modelLabel}`);
                                    } catch (err) {
                                        logger.error(`切换视觉模型失败: ${err.message}`);
                                        UIToolkit.showStatusTip(context.buttonElement, 'error', `切换失败: ${err.message}`);
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
                                        body: JSON.stringify({ service_type: 'vlm', service_id: service.id })
                                    });
                                    if (!res.ok) throw new Error(`服务器返回错误: ${res.status}`);
                                    UIToolkit.showStatusTip(context.buttonElement, 'success', `已切换到: ${service.name}`);
                                    logger.log(`视觉服务切换 | 服务: ${service.name}`);
                                } catch (err) {
                                    logger.error(`切换视觉服务失败: ${err.message}`);
                                    UIToolkit.showStatusTip(context.buttonElement, 'error', `切换失败: ${err.message}`);
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
                        try {
                            const response = await fetch(APIService.getApiUrl('/config/active_prompt'), {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ type: 'vision_zh', prompt_id: prompt.id })
                            });
                            if (response.ok) {
                                UIToolkit.showStatusTip(context.buttonElement, 'success', `已切换到: ${prompt.name}`);
                            } else {
                                throw new Error(`服务器返回错误: ${response.status}`);
                            }
                        } catch (error) {
                            logger.error(`切换中文反推提示词失败: ${error.message}`);
                            UIToolkit.showStatusTip(context.buttonElement, 'error', `切换失败: ${error.message}`);
                        }
                    }
                });

                // 按分类分组规则
                const uncategorizedPrompts = visionPrompts.filter(p => !p.category);
                const categorizedPrompts = visionPrompts.filter(p => p.category);

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
        });

        // 创建反推按钮（英文）
        const buttonEn = this.addButtonWithIcon(assistant, {
            id: 'caption_en',
            title: '反推提示词（英文）',
            icon: 'icon-caption-en',
            onClick: async (e, assistant) => {
                e.preventDefault();
                e.stopPropagation();
                await this.handleImageAnalysis(assistant, 'en');
            },
            // 添加英文反推按钮的右键菜单
            contextMenu: async (assistant) => {
                // 获取服务列表和当前激活状态
                let services = [];
                let currentVLMService = null;
                let currentVLMModel = null;

                // 获取英文反推规则
                let activePromptId = null;
                let visionPrompts = [];

                try {
                    // 获取服务列表
                    const servicesResp = await fetch(APIService.getApiUrl('/services'));
                    if (servicesResp.ok) {
                        const servicesData = await servicesResp.json();
                        if (servicesData.success) {
                            services = servicesData.services || [];
                        }
                    }

                    // 获取当前激活的VLM服务和模型
                    const vlmResp = await fetch(APIService.getApiUrl('/config/vision'));
                    if (vlmResp.ok) {
                        const vlmConfig = await vlmResp.json();
                        currentVLMService = vlmConfig.provider || null;
                        currentVLMModel = vlmConfig.model || null;
                    }

                    // 获取英文反推规则
                    const response = await fetch(APIService.getApiUrl('/config/system_prompts'));
                    if (response.ok) {
                        const data = await response.json();
                        activePromptId = data.active_prompts?.vision_en || null;

                        if (data.vision_prompts) {
                            const originalOrder = Object.keys(data.vision_prompts);
                            originalOrder.forEach(key => {
                                if (key.startsWith('vision_en')) {
                                    const prompt = data.vision_prompts[key];
                                    const showIn = prompt.showIn || ['frontend', 'node'];

                                    // 仅当配置包含 'frontend' 时才在前端菜单显示
                                    if (showIn.includes('frontend')) {
                                        visionPrompts.push({
                                            id: key,
                                            name: prompt.name || key,
                                            category: prompt.category || '',
                                            showIn: showIn,
                                            isActive: key === activePromptId
                                        });
                                    }
                                }
                            });
                            visionPrompts.sort((a, b) =>
                                originalOrder.indexOf(a.id) - originalOrder.indexOf(b.id)
                            );
                        }
                    }
                } catch (error) {
                    logger.error(`获取英文反推配置失败: ${error.message}`);
                }

                // 创建服务菜单项(只显示有VLM模型的服务)
                const serviceMenuItems = services
                    .filter(service => service.vlm_models && service.vlm_models.length > 0)
                    .map(service => {
                        const isCurrentService = currentVLMService === service.id;

                        // 创建模型子菜单
                        const modelChildren = (service.vlm_models || []).map(model => {
                            const isCurrentModel = isCurrentService && currentVLMModel === model.name;
                            return {
                                label: model.display_name || model.name,
                                icon: `<span class="pi ${isCurrentModel ? 'pi-check-circle active-status' : 'pi-circle-off inactive-status'}"></span>`,
                                onClick: async (context) => {
                                    try {
                                        const res = await fetch(APIService.getApiUrl('/services/current'), {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ service_type: 'vlm', service_id: service.id, model_name: model.name })
                                        });
                                        if (!res.ok) throw new Error(`服务器返回错误: ${res.status}`);
                                        const modelLabel = model.display_name || model.name;
                                        UIToolkit.showStatusTip(context.buttonElement, 'success', `已切换到: ${service.name} - ${modelLabel}`);
                                        logger.log(`视觉服务切换 | 服务: ${service.name} | 模型: ${modelLabel}`);
                                    } catch (err) {
                                        logger.error(`切换视觉模型失败: ${err.message}`);
                                        UIToolkit.showStatusTip(context.buttonElement, 'error', `切换失败: ${err.message}`);
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
                                        body: JSON.stringify({ service_type: 'vlm', service_id: service.id })
                                    });
                                    if (!res.ok) throw new Error(`服务器返回错误: ${res.status}`);
                                    UIToolkit.showStatusTip(context.buttonElement, 'success', `已切换到: ${service.name}`);
                                    logger.log(`视觉服务切换 | 服务: ${service.name}`);
                                } catch (err) {
                                    logger.error(`切换视觉服务失败: ${err.message}`);
                                    UIToolkit.showStatusTip(context.buttonElement, 'error', `切换失败: ${err.message}`);
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
                        try {
                            const response = await fetch(APIService.getApiUrl('/config/active_prompt'), {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ type: 'vision_en', prompt_id: prompt.id })
                            });
                            if (response.ok) {
                                UIToolkit.showStatusTip(context.buttonElement, 'success', `已切换到: ${prompt.name}`);
                            } else {
                                throw new Error(`服务器返回错误: ${response.status}`);
                            }
                        } catch (error) {
                            logger.error(`切换英文反推提示词失败: ${error.message}`);
                            UIToolkit.showStatusTip(context.buttonElement, 'error', `切换失败: ${error.message}`);
                        }
                    }
                });

                // 按分类分组规则
                const uncategorizedPrompts = visionPrompts.filter(p => !p.category);
                const categorizedPrompts = visionPrompts.filter(p => p.category);

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
        });

        // Create buttons


        if (buttonZh) {
            assistant.container.addButton(buttonZh, 'caption_zh');
        }
        if (buttonEn) {
            assistant.container.addButton(buttonEn, 'caption_en');
        }
    }

    // ---流式输出辅助方法---

    /**
     * 创建流式显示浮层
     /**
     * 创建节点内嵌流式显示容器
     */
    _createStreamingOverlay(assistant) {
        try {
            const nodeId = assistant.node?.id;
            // 策略1：优先尝试获取 Vue 节点容器
            let mountContainer = document.querySelector(`[data-node-id="${nodeId}"]`);
            let isLiteGraph = false;

            if (!mountContainer) {
                // 策略2：LiteGraph 模式，使用 Body 挂载 + Fixed 定位实现“裁切隔离”
                mountContainer = document.body;
                isLiteGraph = true;
            }

            // 创建外层容器
            const container = document.createElement('div');
            container.className = 'node-streaming-text-container';
            if (isLiteGraph) {
                container.classList.add('is-litegraph');
            }

            // 创建文本内容容器
            const content = document.createElement('div');
            content.className = 'node-streaming-text-content';

            container.appendChild(content);
            mountContainer.appendChild(container);

            // LiteGraph 模式：启动帧同步位置锁定
            let syncHandler = null;
            if (isLiteGraph) {
                const syncPos = () => {
                    if (!assistant.streamingOverlay || !assistant.streamingOverlay.container) return;
                    this._syncLiteGraphPosition(assistant, container);
                    syncHandler = requestAnimationFrame(syncPos);
                };
                syncHandler = requestAnimationFrame(syncPos);
            }

            // 触发入场动画
            requestAnimationFrame(() => {
                container.classList.add('show');
            });

            return { container, content, isLiteGraph, syncHandler };
        } catch (error) {
            logger.error(`创建流式显示容器失败: ${error.message}`);
            return null;
        }
    }

    /**
     * LiteGraph 模式下的位置与几何同步 (Viewport 绝对定位)
     */
    _syncLiteGraphPosition(assistant, container) {
        const node = assistant.node;
        if (!node || !app.canvas) return;

        const ds = app.canvas.ds;
        const pos = node.pos;
        const size = node.size;
        const scale = ds?.scale || 1;

        // 1. 获取节点左上角的屏幕坐标
        let screenX, screenY;
        if (ds && typeof ds.canvas_to_screen === 'function') {
            const screenPos = ds.canvas_to_screen(pos[0], pos[1]);
            screenX = screenPos[0];
            screenY = screenPos[1];
        } else {
            screenX = (pos[0] + (ds?.offset?.[0] || 0)) * scale;
            screenY = (pos[1] + (ds?.offset?.[1] || 0)) * scale;
        }

        // 2. 同步几何尺寸：将节点的逻辑宽度、高度转换成屏幕物理像素
        // 关键点：容器的宽高必须随 scale 同步，才能防止文字“溢出”节点物理边界
        const physicalWidth = size[0] * scale;
        const physicalHeight = 100 * scale; // 逻辑高度 100px 转换为物理像素

        // 3. 计算对齐位置
        // 底部工具栏高度逻辑值为 35px，转换后为 35 * scale
        const bottomOffset = 35 * scale;
        const top = screenY + (size[1] * scale) - bottomOffset - physicalHeight;

        // 4. 应用样式到同步容器
        container.style.width = `${physicalWidth - 16 * scale}px`; // 减去边缘间距
        container.style.height = `${physicalHeight}px`;
        container.style.left = `${screenX + 8 * scale}px`;
        container.style.top = `${top}px`;

        // 5. 同步内容缩放：确保字号随节点大小变化
        // 注意：我们通过改变容器的 fontSize 来影响内容。
        // content 容器内部使用相对单位或依靠父级继承。
        const content = container.querySelector('.node-streaming-text-content');
        if (content) {
            content.style.fontSize = `${10 * scale}px`;
            content.style.lineHeight = `${1.6}`;
        }
    }

    /**
     * 移除流式内嵌容器
     */
    _removeStreamingOverlay(assistant, overlayObj) {
        if (!overlayObj || !overlayObj.container) return;
        const { container, syncHandler } = overlayObj;

        // 停止同步循环
        if (syncHandler) {
            cancelAnimationFrame(syncHandler);
        }

        try {
            container.classList.remove('show');
            setTimeout(() => {
                if (container.parentNode) {
                    container.parentNode.removeChild(container);
                }
            }, 300);
        } catch (error) {
            logger.error(`移除流式容器失败: ${error.message}`);
            if (container.parentNode) container.parentNode.removeChild(container);
        }
    }

    /**
     * 处理图像分析
     */
    async handleImageAnalysis(assistant, lang) {
        // 存储当前请求ID，用于取消操作
        let currentRequestId = null;

        try {
            const node = assistant.node;

            // Vue Node 2.0 模式：从 DOM 获取当前显示的图像
            // 传统 LiteGraph 模式：使用 node.imgs 属性
            let currentImage = null;
            const isVueMode = nodeMountService.isVueNodesMode();

            if (isVueMode) {
                // Vue Node 2.0 模式：从节点容器的 DOM 中获取图像
                const nodeContainer = document.querySelector(`[data-node-id="${node.id}"]`);
                if (nodeContainer) {
                    // 查找节点容器内的 img 元素（优先查找预览图像）
                    const imgElement = nodeContainer.querySelector('img');
                    if (imgElement && imgElement.src) {
                        // 使用 DOM 中的图像 src
                        currentImage = imgElement.src;
                        logger.debug(`[图像小助手-Vue模式] 从DOM获取图像 | 节点ID: ${node.id}`);
                    }
                }
            }

            // 如果 Vue 模式未找到图像，或者是传统模式，使用 node.imgs
            if (!currentImage) {
                if (!node.imgs || node.imgs.length === 0) {
                    throw new Error('未找到有效的图像');
                }
                currentImage = node.imgs[node.imageIndex || 0];
                if (!currentImage) {
                    throw new Error('未找到有效的图像');
                }
            }

            // 获取按钮元素
            const buttonId = lang === 'en' ? 'caption_en' : 'caption_zh';
            const buttonElement = assistant.buttons[buttonId];
            if (!buttonElement) {
                throw new Error('未找到按钮元素');
            }

            // 检查按钮是否已经处于处理状态，如果是，则取消当前请求
            if (buttonElement.classList.contains('button-processing') && assistant.currentRequestId) {
                // 取消当前请求
                await APIService.cancelRequest(assistant.currentRequestId);

                // 显示取消提示
                UIToolkit.showStatusTip(
                    buttonElement,
                    'info',
                    '反推已取消',
                    { x: buttonElement.getBoundingClientRect().left + buttonElement.offsetWidth / 2, y: buttonElement.getBoundingClientRect().top }
                );

                // 重置按钮状态
                this._setButtonState(assistant, buttonId, 'processing', false);

                // 恢复其他按钮状态
                Object.keys(assistant.buttons).forEach(id => {
                    if (id !== buttonId) {
                        this._setButtonState(assistant, id, 'disabled', false);
                    }
                });

                // 更新小助手状态为非激活状态
                this._updateAssistantActiveState(assistant, false);

                // 清除当前请求ID
                assistant.currentRequestId = null;

                return;
            }

            // 设置当前按钮为处理中状态
            this._setButtonState(assistant, buttonId, 'processing', true);

            // 禁用其他按钮
            Object.keys(assistant.buttons).forEach(id => {
                if (id !== buttonId) {
                    this._setButtonState(assistant, id, 'disabled', true);
                }
            });

            // 更新小助手状态为激活状态
            this._updateAssistantActiveState(assistant, true);

            // 显示加载状态提示
            const tipMessage = lang === 'en' ? "反推提示词...（英文）" : "反推提示词...（中文）";
            UIToolkit.showStatusTip(
                buttonElement,
                'loading',
                tipMessage,
                { x: buttonElement.getBoundingClientRect().left + buttonElement.offsetWidth / 2, y: buttonElement.getBoundingClientRect().top }
            );

            // 生成请求ID
            // 生成请求ID
            currentRequestId = APIService.generateRequestId('icap', null, node.id);
            // 保存到assistant对象中，以便取消操作
            assistant.currentRequestId = currentRequestId;

            // 将图像转换为Base64
            let imageBase64;
            try {
                imageBase64 = await APIService.imageToBase64(currentImage);
                if (!imageBase64) {
                    throw new Error('图像转换失败');
                }
            } catch (e) {
                throw new Error(`图像转换失败: ${e.message || e}`);
            }

            // 确保图像数据格式正确
            if (typeof imageBase64 !== 'string') {
                throw new Error(`图像数据类型错误: ${typeof imageBase64}`);
            }

            // 确保图像数据是Base64格式
            if (!imageBase64.startsWith('data:image')) {
                imageBase64 = `data:image/jpeg;base64,${imageBase64}`;
            }

            // 获取当前激活的提示词内容
            let promptContent = '';
            try {
                const response = await fetch(APIService.getApiUrl('/config/system_prompts'));
                if (response.ok) {
                    const data = await response.json();
                    const activePromptKey = `vision_${lang}`;
                    const activePromptId = data.active_prompts?.[activePromptKey];
                    if (activePromptId && data.vision_prompts?.[activePromptId]) {
                        promptContent = data.vision_prompts[activePromptId].content;
                    }
                }
                if (!promptContent) {
                    throw new Error(`未找到有效的 ${lang === 'zh' ? '中文' : '英文'} 反推提示词`);
                }
            } catch (error) {
                throw new Error(`获取反推规则失败: ${error.message}`);
            }

            // 根据开关选择流式或阻塞式 API
            let result;
            let fullContent = '';

            if (FEATURES.enableStreaming !== false) {
                // 创建内嵌流式对象
                const overlayObj = this._createStreamingOverlay(assistant);
                if (!overlayObj) {
                    logger.error("[图像小助手] 无法创建内嵌流式显示对象");
                    return;
                }
                assistant.streamingOverlay = overlayObj;
                // 使用流式 API 调用图像分析服务
                result = await APIService.llmAnalyzeImageStream(
                    imageBase64,
                    promptContent,
                    currentRequestId,
                    (chunk) => {
                        // 流式回调：实时更新浮层内容
                        fullContent += chunk;
                        if (assistant.streamingOverlay && assistant.streamingOverlay.content) {
                            const contentEl = assistant.streamingOverlay.content;

                            // 更新文本内容
                            contentEl.textContent = fullContent;

                            // 滚动容器（保持在底部）
                            const container = assistant.streamingOverlay.container;
                            container.scrollTop = container.scrollHeight;
                        }
                    }
                );

                // 确保流式内容在完成后被赋值到结果对象中
                if (result && result.success && fullContent) {
                    if (!result.data) result.data = {};
                    result.data.description = fullContent;
                }
            } else {
                // ---阻塞输出：直接调用图像分析服务---
                result = await APIService.llmAnalyzeImage(
                    imageBase64,
                    promptContent,
                    currentRequestId
                );
            }

            // 移除流式内嵌容器
            if (assistant.streamingOverlay) {
                this._removeStreamingOverlay(assistant, assistant.streamingOverlay);
                assistant.streamingOverlay = null;
            }

            // 清除当前请求ID
            assistant.currentRequestId = null;

            // 检查是否被取消
            if (result && result.cancelled) {
                logger.debug(`图像分析请求已取消 | ID: ${currentRequestId}`);
                return;
            }

            if (!result || !result.success) {
                const errorMsg = result?.error || '未知错误';
                throw new Error(errorMsg);
            }

            // 获取描述文本（优先使用流式收集的内容）
            const description = fullContent || result.data?.description;
            if (!description) {
                throw new Error('未获取到图像描述');
            }

            // 尝试复制到剪贴板
            let copySuccess = false;
            try {
                // 优先使用现代的 Clipboard API
                if (navigator.clipboard && window.isSecureContext) {
                    await navigator.clipboard.writeText(description);
                    copySuccess = true;
                } else {
                    // 创建一个临时的textarea元素
                    const textarea = document.createElement('textarea');
                    textarea.value = description;
                    textarea.style.position = 'fixed';
                    textarea.style.left = '0';
                    textarea.style.top = '0';
                    textarea.style.opacity = '0';
                    document.body.appendChild(textarea);

                    // 尝试聚焦并选中文本
                    textarea.focus();
                    textarea.select();
                    textarea.setSelectionRange(0, textarea.value.length);

                    // 尝试复制
                    try {
                        copySuccess = document.execCommand('copy');
                    } catch (err) {
                        logger.warn(`execCommand复制失败: ${err.message}`);
                    }

                    // 移除临时元素
                    document.body.removeChild(textarea);
                }

                if (!copySuccess) {
                    throw new Error('复制到剪贴板操作未能成功执行');
                }
            } catch (copyError) {
                logger.warn(`复制到剪贴板失败: ${copyError.message}`);
                // 即使复制失败也继续执行，不抛出错误，但记录状态
                copySuccess = false;
            }

            // 为当前图像节点创建历史记录
            HistoryCacheService.addHistory({
                node_id: node.id,
                input_id: "image",
                content: description,
                operation_type: 'caption',
                timestamp: Date.now(),
                request_id: currentRequestId
            });

            // 显示成功提示
            const successMessage = copySuccess
                ? (lang === 'en' ? "反推完成，已复制到剪贴板" : "反推完成，已复制到剪贴板")
                : (lang === 'en' ? "反推完成，但复制失败" : "反推完成，但复制失败");

            UIToolkit.showStatusTip(
                buttonElement,
                copySuccess ? 'success' : 'warning',
                successMessage,
                { x: buttonElement.getBoundingClientRect().left + buttonElement.offsetWidth / 2, y: buttonElement.getBoundingClientRect().top }
            );

            // 限制Toast显示的文本长度
            const maxLength = 40;
            const truncatedDescription = description.length > maxLength
                ? description.substring(0, maxLength) + '...'
                : description;

            // 显示Toast提示
            app.extensionManager.toast.add({
                severity: copySuccess ? "success" : "info",
                summary: copySuccess
                    ? (lang === 'en' ? "图像反推完成（英文），请使用 ctrl+v 粘贴" : "图像反推完成（中文），请使用 ctrl+v 粘贴")
                    : (lang === 'en' ? "图像反推完成（英文），但复制失败，请手动复制" : "图像反推完成（中文），但复制失败，请手动复制"),
                detail: truncatedDescription,
                life: 5000
            });

            // 如果复制失败，创建一个对话框显示结果，允许用户手动复制
            if (!copySuccess) {
                this._showCopyDialog(description, lang);
            }

        } catch (error) {
            // 清除当前请求ID
            assistant.currentRequestId = null;

            logger.error(`图像分析失败: ${error.message}`);

            // 获取按钮元素
            const buttonId = lang === 'en' ? 'caption_en' : 'caption_zh';
            const buttonElement = assistant.buttons[buttonId];

            if (buttonElement) {
                // 显示错误提示
                UIToolkit.showStatusTip(
                    buttonElement,
                    'error',
                    error.message,
                    { x: buttonElement.getBoundingClientRect().left + buttonElement.offsetWidth / 2, y: buttonElement.getBoundingClientRect().top }
                );
            };

            app.extensionManager.toast.add({
                severity: "error",
                summary: lang === 'en' ? "Error" : "错误",
                detail: error.message,
                life: 3000
            });
        } finally {
            // 获取按钮ID
            const buttonId = lang === 'en' ? 'caption_en' : 'caption_zh';

            // 重置当前按钮状态
            this._setButtonState(assistant, buttonId, 'processing', false);

            // 恢复其他按钮状态
            Object.keys(assistant.buttons).forEach(id => {
                if (id !== buttonId) {
                    this._setButtonState(assistant, id, 'disabled', false);
                }
            });

            // 更新小助手状态为非激活状态
            this._updateAssistantActiveState(assistant, false);
        }
    }

    /**
     * 显示复制对话框
     * 当剪贴板API失败时，提供一个对话框让用户手动复制内容
     */
    _showCopyDialog(content, lang) {
        // 创建对话框容器
        const dialogContainer = document.createElement('div');
        dialogContainer.className = 'image-assistant-copy-dialog';

        // 创建标题
        const title = document.createElement('div');
        title.className = 'image-assistant-copy-dialog-title';
        title.textContent = '由于剪贴板权限被限制，请手动点击复制提示词内容';
        dialogContainer.appendChild(title);

        // 创建关闭按钮
        const closeButton = document.createElement('button');
        closeButton.className = 'image-assistant-copy-dialog-close';
        closeButton.onclick = () => {
            document.body.removeChild(dialogContainer);
        };

        // 添加关闭图标
        UIToolkit.addIconToButton(closeButton, 'pi-times', '关闭');
        dialogContainer.appendChild(closeButton);

        // 创建文本区域
        const contentArea = document.createElement('textarea');
        contentArea.className = 'image-assistant-copy-dialog-textarea';
        contentArea.value = content;
        contentArea.readOnly = true;
        dialogContainer.appendChild(contentArea);

        // 创建复制按钮
        const copyButton = document.createElement('button');
        copyButton.className = 'image-assistant-copy-dialog-copy-btn';
        copyButton.textContent = '复制到剪贴板';
        copyButton.onclick = () => {
            contentArea.select();
            try {
                const success = document.execCommand('copy');
                if (success) {
                    copyButton.textContent = '复制成功!';
                    // 复制成功后，延迟500ms关闭弹窗，让用户看到成功提示
                    setTimeout(() => {
                        if (document.body.contains(dialogContainer)) {
                            document.body.removeChild(dialogContainer);
                        }
                    }, 500);
                } else {
                    copyButton.textContent = '复制失败，请手动选择和复制';
                    contentArea.focus();
                }
            } catch (err) {
                copyButton.textContent = '复制失败，请手动选择和复制';
                contentArea.focus();
            }
        };
        dialogContainer.appendChild(copyButton);

        // 添加到文档
        document.body.appendChild(dialogContainer);

        // 聚焦内容区域，使用户可以立即复制
        setTimeout(() => {
            contentArea.focus();
            contentArea.select();
        }, 100);
    }

    /**
     * 设置按钮状态
     */
    _setButtonState(assistant, buttonId, stateType, value = true) {
        try {
            const button = assistant.buttons[buttonId];
            if (!button) return;

            const stateClass = `button-${stateType}`;

            if (value) {
                button.classList.add(stateClass);
                // 如果是禁用状态，添加disabled属性
                if (stateType === 'disabled') {
                    button.setAttribute('disabled', 'disabled');
                }
            } else {
                button.classList.remove(stateClass);
                // 如果取消禁用状态，移除disabled属性
                if (stateType === 'disabled') {
                    button.removeAttribute('disabled');
                }
            }

            // 更新按钮可点击状态
            this._updateButtonClickability(button, stateType, value);

        } catch (error) {
            logger.error(`按钮状态 | 设置失败 | 按钮:${buttonId} | 状态:${stateType} | 错误:${error.message}`);
        }
    }

    /**
     * 更新按钮可点击状态
     */
    _updateButtonClickability(button, stateType, value) {
        // 检查按钮是否处于禁用状态
        const isDisabled = button.classList.contains('button-disabled');

        // 处理中的按钮仍然可点击（用于取消操作）
        const isProcessing = button.classList.contains('button-processing');

        if (isDisabled) {
            // 如果按钮被禁用，阻止点击事件
            button.style.pointerEvents = 'none';
        } else {
            // 恢复点击事件，包括处理中的按钮
            button.style.pointerEvents = 'auto';
        }
    }

    /**
     * 检查小助手是否有按钮处于激活状态
     */
    _checkAssistantActiveState(assistant) {
        if (!assistant || !assistant.buttons) return false;

        // 0. 检查是否正在切换弹窗（切换期间不允许折叠）
        if (PopupManager._isTransitioning) {

            return true;
        }

        // 1. 检查右键菜单是否可见（并且属于当前 assistant）
        if (buttonMenu.isMenuVisible && buttonMenu.menuContext?.widget === assistant) {

            return true;
        }

        // 2. 检查 PopupManager 的活动弹窗是否属于当前 assistant
        if (PopupManager.activePopupInfo?.buttonInfo?.widget === assistant) {

            return true;
        }

        // 3. 检查按钮的 active/processing 状态
        for (const buttonId in assistant.buttons) {
            const button = assistant.buttons[buttonId];
            if (button.classList.contains('button-active') ||
                button.classList.contains('button-processing')) {

                return true;
            }
        }

        return false;
    }

    /**
     * 更新小助手激活状态
     */
    _updateAssistantActiveState(assistant, isActive) {
        if (!assistant) return;

        // 更新激活状态
        assistant.isActive = isActive;

        // 如果激活，强制显示小助手
        if (isActive) {
            this.showAssistantUI(assistant);
        } else {
            // 如果不再激活，先更新可见性
            this.updateAssistantVisibility(assistant);

            // 然后手动触发自动折叠（如果小助手仍然可见且处于展开状态）
            if (assistant.element &&
                assistant.element.style.display !== 'none' &&
                !assistant.isCollapsed &&
                !assistant.isTransitioning) {
                // 延迟一点时间再触发折叠，让用户有时间看到结果
                setTimeout(() => {
                    this.triggerAutoCollapse(assistant);
                }, 1500); // 1.5秒后自动折叠，给用户足够时间查看结果
            }
        }
    }

    /**
     * 显示小助手UI 
     */
    showAssistantUI(assistant) {
        if (!assistant?.element) return;

        // 避免重复显示
        if (assistant.element.classList.contains('image-assistant-show')) {
            // 确保元素可见
            assistant.element.style.display = 'flex';
            assistant.element.style.opacity = '1';
            return;
        }

        // 直接显示，无动画过渡
        assistant.element.style.opacity = '1';
        assistant.element.style.display = 'flex';
        assistant.element.classList.add('image-assistant-show');

        // 确保悬停区域可见（用于折叠状态下的交互）
        if (assistant.isCollapsed && assistant.hoverArea) {
            assistant.hoverArea.style.display = 'block';
        }

        // 重置过渡状态
        assistant.isTransitioning = false;

        // 只有当明确不是折叠状态时才触发自动折叠
        if (!assistant.isCollapsed) {
            this.triggerAutoCollapse(assistant);
        }
    }

    /**
     * 隐藏小助手UI
     */
    hideAssistantUI(assistant) {
        if (!assistant?.element) return;

        // 清除自动折叠定时器
        if (assistant._autoCollapseTimer) {
            clearTimeout(assistant._autoCollapseTimer);
            assistant._autoCollapseTimer = null;
        }

        // 隐藏元素
        assistant.element.style.display = 'none';
        assistant.element.classList.remove('image-assistant-show');

        // 重置状态
        assistant.isTransitioning = false;
    }

    /**
     * 更新小助手可见性
     */
    updateAssistantVisibility(assistant) {
        // 检查实例是否已销毁
        if (!assistant || assistant.isDestroyed) return;

        // 动态获取节点
        const node = assistant.node;

        // 记录当前显示状态，用于检测变化
        const wasVisible = assistant.element &&
            assistant.element.style.display !== 'none' &&
            assistant.element.classList.contains('image-assistant-show');

        // 检查总开关和图像反推功能开关状态
        if (!window.FEATURES || !window.FEATURES.enabled || !window.FEATURES.imageCaption) {
            this.cleanup(assistant.nodeId);
            return;
        }

        // 检查节点是否已被删除
        if (!node) {
            this.cleanup(assistant.nodeId);
            return;
        }

        // 检查节点是否已被删除
        if (!node) {
            this.cleanup(assistant.nodeId);
            return;
        }

        // --- 修复：LiteGraph 子图“幽灵”图标问题 ---
        // 检查节点所属的 graph 是否为当前激活的 graph
        // 如果当前处在子图中，而节点在父图，则应隐藏
        // 注意：app.canvas.graph 是当前视图显示的 graph
        if (app.canvas && app.canvas.graph && node.graph && node.graph !== app.canvas.graph) {
            // 节点不在当前显示的 graph 中，强制隐藏
            // logger.debugSample(() => `[图像小助手] 节点不在当前视图中，强制隐藏 | ID: ${assistant.nodeId}`);
            this.hideAssistantUI(assistant);
            return;
        }

        // 使用统一的状态检测方法
        const nodeState = this._checkNodeAndCanvasState(assistant.node);

        // 检查是否有按钮处于激活状态
        const hasActiveButtons = this._checkAssistantActiveState(assistant);

        // 确定新的可见性状态
        let shouldBeVisible = true;

        // 如果有激活的按钮，强制显示小助手（覆盖其他隐藏条件）
        if (hasActiveButtons) {
            this.showAssistantUI(assistant);

            // 如果当前是折叠状态，则展开
            if (assistant.isCollapsed) {
                this._expandAssistant(assistant);
            }

            return;
        }

        // 如果节点折叠或画布缩放过小，隐藏小助手但不清理实例
        if (nodeState.isCollapsed || nodeState.isLowQuality) {
            shouldBeVisible = false;
        }

        // 如果节点没有有效图像，隐藏小助手但不清理实例
        if (!nodeState.hasValidImage) {
            shouldBeVisible = false;

            // ---异步图像检测逻辑 (针对性能优化)---
            // 如果节点是支持的类型但暂时没图，启动一个内部轻量级探测器
            if (!assistant._imageDetectionTimer) {
                const detectImage = () => {
                    // 检查实例是否已被清理或节点是否已不再图中
                    if (assistant.isDestroyed || !assistant.node) {
                        assistant._imageDetectionTimer = null;
                        return;
                    }

                    const currentState = this._checkNodeAndCanvasState(assistant.node);
                    if (currentState.hasValidImage) {
                        logger.debug(() => `[图像小助手] 异步图像加载成功 | ID: ${assistant.nodeId}`);
                        assistant._imageDetectionTimer = null;

                        // 额外检查：如果 element 已经丢失（可能是 Vue 重新渲染），重新初始化
                        const isVueMode = nodeMountService.isVueNodesMode();
                        const nodeContainer = isVueMode ? document.querySelector(`[data-node-id="${assistant.nodeId}"]`) : null;
                        const isElementPresent = isVueMode ? nodeContainer?.contains(assistant.element) : document.body.contains(assistant.element);

                        if (!assistant.element || !isElementPresent) {
                            this.checkAndSetupNode(assistant.node);
                        } else {
                            this.updateAssistantVisibility(assistant);
                        }
                    } else {
                        // 继续等待，每秒检测一次 (开销极低)
                        assistant._imageDetectionTimer = setTimeout(detectImage, 1000);
                    }
                };
                assistant._imageDetectionTimer = setTimeout(detectImage, 1000);
            }
        } else {
            // 已有图像，清理探测定时器
            if (assistant._imageDetectionTimer) {
                clearTimeout(assistant._imageDetectionTimer);
                assistant._imageDetectionTimer = null;
            }
        }

        // 跳过正在过渡的实例，避免动画中断
        if (assistant.isTransitioning) {
            return;
        }

        // 根据可见性状态更新UI
        if (shouldBeVisible) {
            // 条件满足时显示小助手
            this.showAssistantUI(assistant);
        } else {
            // 隐藏小助手
            this.hideAssistantUI(assistant);
        }
    }

    /**
     * 展开小助手
     */

    _expandAssistant(assistant) {
        if (assistant && assistant.container) {
            assistant.container.expand();
        }
    }


    /**
     * 触发自动折叠
     */

    triggerAutoCollapse(assistant) {
        if (assistant && assistant.container) {
            assistant.container.collapse();
        }
    }




    /**
     * 添加带图标的按钮
     */
    addButtonWithIcon(assistant, config) {
        if (!assistant?.element || !assistant?.innerContent) return null;

        const { id, title, icon, onClick, contextMenu } = config;

        // 创建按钮
        const button = document.createElement('button');
        button.className = 'image-assistant-button';
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

                // 即使按钮正在处理中也允许点击，用于取消操作
                // 如果按钮被禁用，不执行操作
                if (button.classList.contains('button-disabled')) {
                    return;
                }

                // 执行点击回调
                onClick(e, assistant);
            });
        }

        // 添加右键菜单（如果有）
        if (contextMenu && typeof contextMenu === 'function') {
            this._setupButtonContextMenu(button, contextMenu, assistant);
        }

        // 保存引用
        if (id) {
            assistant.buttons[id] = button;
        }

        return button;
    }

    /**
     * 设置UI位置
     * 支持 Vue node2.0 和 litegraph.js 两种渲染模式
     */
    _setupUIPosition(assistant) {
        if (!assistant?.element || !assistant?.node) return;

        const containerDiv = assistant.element;
        const renderMode = nodeMountService.detectRenderMode();

        // 保存渲染模式到assistant
        assistant._renderMode = renderMode;

        if (renderMode === RENDER_MODE.VUE_NODES) {
            // Vue node2.0 模式：使用相对定位挂载到节点容器内
            this._setupUIPositionVueNodes(assistant, containerDiv);
        } else {
            // litegraph.js 模式：使用fixed定位和画布坐标计算
            this._setupUIPositionLitegraph(assistant, containerDiv);
        }
    }

    /**
     * Vue node2.0 模式下的定位逻辑
     */
    _setupUIPositionVueNodes(assistant, containerDiv) {
        const containerInfo = nodeMountService.findImageNodeContainer(assistant.node);

        if (!containerInfo || !containerInfo.container) {
            logger.warn(`[图像小助手-Vue定位] 未找到节点容器 | ID: ${assistant.node.id}`);
            // 降级到litegraph模式
            this._setupUIPositionLitegraph(assistant, containerDiv);
            return;
        }

        const { container: nodeContainer } = containerInfo;

        // Vue模式：使用绝对定位，挂载到节点容器内（右侧对齐，无需上移避让由于左侧的ID）
        containerDiv.style.position = 'absolute';
        containerDiv.style.right = '6px';
        containerDiv.style.bottom = '6px';
        containerDiv.style.left = 'auto';
        containerDiv.style.top = 'auto';
        containerDiv.style.zIndex = '10';

        // 移除fixed定位相关样式
        containerDiv.style.transform = 'none';

        // 添加Vue模式标记类
        containerDiv.classList.add('vue-node-mode');

        // 从document.body移除（如果之前挂载过）
        if (containerDiv.parentElement === document.body) {
            document.body.removeChild(containerDiv);
        }

        // 挂载到节点容器
        nodeContainer.appendChild(containerDiv);

        // 添加清理函数
        assistant._eventCleanupFunctions = assistant._eventCleanupFunctions || [];
        assistant._eventCleanupFunctions.push(() => {
            if (containerDiv && containerDiv.parentElement) {
                containerDiv.parentElement.removeChild(containerDiv);
            }
        });

        logger.debug(`[图像小助手-Vue定位] 完成 | 节点ID: ${assistant.node.id}`);
    }

    /**
     * litegraph.js 模式下的定位逻辑（原有逻辑）
     */
    _setupUIPositionLitegraph(assistant, containerDiv) {
        // 更新位置的函数
        // 缓存最后一次写入 DOM 的值，未变化时跳过 style 写入
        // 避免高节点数下每帧触发 N 次 Recalculate Style
        const lastApplied = { sx: NaN, sy: NaN, scale: NaN, hidden: false };

        const updatePosition = () => {
            if (!assistant.element || !assistant.node) return;

            try {
                const canvas = app.canvas;
                if (!canvas) {
                    requestAnimationFrame(() => updatePosition());
                    return;
                }

                const scale = canvas.ds.scale;

                // 视口剔除：节点不在可见区域时直接隐藏，跳过定位计算
                // 大工作流低缩放下 N 个节点全在视口外仍跑 updatePosition 是主要性能瓶颈
                const [nodeX, nodeY, nodeWidth, nodeHeight] = assistant.node.getBounding();
                const visibleArea = canvas.ds?.visible_area;
                if (visibleArea && visibleArea[2] > 0 && visibleArea[3] > 0) {
                    const vx = visibleArea[0], vy = visibleArea[1];
                    const vw = visibleArea[2], vh = visibleArea[3];
                    const intersects =
                        nodeX + nodeWidth > vx &&
                        nodeX < vx + vw &&
                        nodeY + nodeHeight > vy &&
                        nodeY < vy + vh;
                    if (!intersects) {
                        if (!lastApplied.hidden) {
                            containerDiv.style.display = 'none';
                            lastApplied.hidden = true;
                        }
                        return;
                    }
                    if (lastApplied.hidden) {
                        containerDiv.style.display = '';
                        lastApplied.hidden = false;
                    }
                }

                const INNER_OFFSET_X = 6;
                const INNER_OFFSET_Y = 6;

                const anchorX = nodeX + INNER_OFFSET_X;
                const anchorY = nodeY + nodeHeight - INNER_OFFSET_Y;

                const rect = canvas.canvas.getBoundingClientRect();
                const canvasPoint = canvas.convertOffsetToCanvas([anchorX, anchorY]);
                if (!canvasPoint) return;

                const screenX = canvasPoint[0] + rect.left;
                const screenY = canvasPoint[1] + rect.top;

                // change detection：只有屏幕坐标或缩放变了才写 DOM
                if (
                    screenX !== lastApplied.sx ||
                    screenY !== lastApplied.sy ||
                    scale !== lastApplied.scale
                ) {
                    containerDiv.style.left = `${screenX}px`;
                    containerDiv.style.bottom = `${window.innerHeight - screenY}px`;
                    containerDiv.style.right = 'auto';
                    containerDiv.style.top = 'auto';
                    containerDiv.style.setProperty('--assistant-scale', scale);
                    lastApplied.sx = screenX;
                    lastApplied.sy = screenY;
                    lastApplied.scale = scale;
                }

            } catch (error) {
                if (!assistant._lastPositionError) {
                    logger.error(() => `更新小助手位置失败: ${error.message}`);
                    assistant._lastPositionError = Date.now();
                }
            }
        };

        // 初始更新位置
        updatePosition();

        // 使用防抖函数优化位置更新
        const debouncedUpdatePosition = EventManager.debounce(updatePosition, 16);

        // 添加窗口resize事件监听
        assistant._eventCleanupFunctions = assistant._eventCleanupFunctions || [];
        const removeResizeListener = EventManager.addDOMListener(window, 'resize', debouncedUpdatePosition);
        assistant._eventCleanupFunctions.push(removeResizeListener);

        // 监听画布变化
        if (app.canvas) {
            // 单一全局 onDrawBackground 钩子 + 全局 updater 注册表
            // 改之前每个 assistant 都 wrap 一次 onDrawBackground，N 个节点 = N 层嵌套调用，
            // 大工作流每帧走 N 层包装链 → 严重卡顿。改成只 wrap 一次，迭代注册表。
            // 同时栈式 wrap 的 cleanup 只能拆顶层，下面的永远拆不掉，会随节点累积。
            if (!ImageCaption._globalDrawHookInstalled && app.canvas) {
                ImageCaption._activePositionUpdaters = ImageCaption._activePositionUpdaters || new Set();
                const origDrawBg = app.canvas.onDrawBackground;
                const globalDrawWrapper = function () {
                    const ret = origDrawBg?.apply(this, arguments);
                    for (const fn of ImageCaption._activePositionUpdaters) {
                        try { fn(); } catch (_) {}
                    }
                    return ret;
                };
                app.canvas.onDrawBackground = globalDrawWrapper;
                ImageCaption._globalDrawHookInstalled = true;
            }

            ImageCaption._activePositionUpdaters.add(updatePosition);
            assistant._eventCleanupFunctions.push(() => {
                ImageCaption._activePositionUpdaters?.delete(updatePosition);
            });

            // 监听节点移动
            if (assistant.node) {
                // 使用LiteGraph提供的onNodeMoved事件
                const originalOnNodeMoved = app.canvas.onNodeMoved;
                app.canvas.onNodeMoved = function (node_dragged) {
                    if (originalOnNodeMoved) {
                        originalOnNodeMoved.apply(this, arguments);
                    }

                    // 仅当移动的是当前节点时更新位置
                    if (node_dragged && node_dragged.id === assistant.node.id) {
                        updatePosition();
                    }
                };

                // 添加节点移动清理函数
                assistant._eventCleanupFunctions.push(() => {
                    if (app.canvas) {
                        app.canvas.onNodeMoved = originalOnNodeMoved;
                    }
                });

                // 为节点本身添加移动监听（兼容性处理）
                const nodeOriginalOnNodeMoved = assistant.node.onNodeMoved;
                assistant.node.onNodeMoved = function () {
                    const ret = nodeOriginalOnNodeMoved?.apply(this, arguments);
                    updatePosition();
                    return ret;
                };

                // 添加节点自身移动清理函数
                assistant._eventCleanupFunctions.push(() => {
                    if (assistant.node && nodeOriginalOnNodeMoved) {
                        assistant.node.onNodeMoved = nodeOriginalOnNodeMoved;
                    }
                });
            }

            // 监听画布缩放
            const originalDSModified = app.canvas.ds.onModified;
            app.canvas.ds.onModified = function (...args) {
                if (originalDSModified) {
                    originalDSModified.apply(this, args);
                }
                // 缩放时直接更新
                updatePosition();
            };

            // 添加画布缩放清理函数
            assistant._eventCleanupFunctions.push(() => {
                if (app.canvas?.ds) {
                    app.canvas.ds.onModified = originalDSModified;
                }
            });
        }

        // 添加DOM元素清理函数
        assistant._eventCleanupFunctions.push(() => {
            if (containerDiv && document.body.contains(containerDiv)) {
                document.body.removeChild(containerDiv);
            }
        });
    }

    /**
     * 设置节点折叠状态监听
     */
    _setupNodeCollapseListener(assistant) {
        if (!assistant?.node) return;

        const node = assistant.node;

        // 保存原始的 collapse 方法
        const originalCollapse = node.collapse;

        // 重写 collapse 方法
        node.collapse = function () {
            // 调用原始的 collapse 方法
            originalCollapse.apply(this, arguments);

            // 调用统一的可见性更新方法，而不是直接操作DOM
            const imageCaptionInstance = window.imageCaptionInstance || imageCaption;
            if (imageCaptionInstance && typeof imageCaptionInstance.updateAssistantVisibility === 'function') {
                imageCaptionInstance.updateAssistantVisibility(assistant);
            }
        };

        // 保存清理函数
        assistant._eventCleanupFunctions.push(() => {
            // 恢复原始的 collapse 方法
            if (node.collapse !== originalCollapse) {
                node.collapse = originalCollapse;
            }
        });
    }

    /**
     * 设置画布缩放监听
     */
    _setupCanvasScaleListener(assistant) {
        if (!assistant?.node || !app.canvas) return;

        let lastScale = app.canvas.ds.scale;

        // 使用类方法获取阈值，确保一致性
        const threshold = this._getQualityThreshold();

        // 直接检测缩放状态并更新UI可见性
        const checkScaleAndUpdate = () => {
            if (!assistant.element || !assistant.node || !app.canvas) return;

            const currentScale = app.canvas.ds.scale;
            const threshold = imageCaption._getQualityThreshold(); // 修复：使用全局实例的方法
            const epsilon = 0.001; // 增加容差值

            // 计算与上次缩放的差值
            const scaleDiff = Math.abs(currentScale - lastScale);

            // 更新上次缩放值
            lastScale = currentScale;

            // 判断当前画质状态（使用容差值）
            const isCurrentlyLowQuality = currentScale <= threshold + epsilon;

            // 无条件更新UI可见性，让_checkNodeAndCanvasState方法决定是否显示
            this.updateAssistantVisibility(assistant);
        };

        // 确保立即响应
        const immediateUpdate = checkScaleAndUpdate;

        // 监听画布的鼠标滚轮事件（缩放）
        const wheelHandler = (e) => {
            if (e.ctrlKey || e.metaKey) {
                // 立即更新并安排延迟检查
                immediateUpdate();
                setTimeout(immediateUpdate, 50);
            }
        };

        // 监听画布的触摸事件（移动端缩放）
        const touchHandler = (e) => {
            if (e.touches && e.touches.length === 2) {
                // 立即更新并安排延迟检查
                immediateUpdate();
                setTimeout(immediateUpdate, 50);
            }
        };

        // 添加事件监听器
        const canvas = app.canvas.canvas;
        if (canvas) {
            canvas.addEventListener('wheel', wheelHandler, { passive: true });
            canvas.addEventListener('touchmove', touchHandler, { passive: true });
        }

        // 定期检查缩放变化
        const scaleCheckInterval = setInterval(immediateUpdate, 50);

        // 初始检查一次当前状态
        immediateUpdate();

        // 保存清理函数
        assistant._eventCleanupFunctions.push(() => {
            if (canvas) {
                canvas.removeEventListener('wheel', wheelHandler);
                canvas.removeEventListener('touchmove', touchHandler);
            }
            clearInterval(scaleCheckInterval);
        });

        // 监听画布缩放事件（直接监听ds.scale变化）
        const originalDSScale = Object.getOwnPropertyDescriptor(app.canvas.ds, 'scale');
        if (originalDSScale && originalDSScale.set) {
            const originalSetter = originalDSScale.set;

            Object.defineProperty(app.canvas.ds, 'scale', {
                get: originalDSScale.get,
                set: function (value) {
                    // 获取旧值
                    const oldValue = this.scale;
                    const threshold = imageCaption._getQualityThreshold();

                    // 调用原始setter
                    originalSetter.call(this, value);

                    // 检测是否跨越了阈值边界
                    const epsilon = 0.001;
                    const crossedThreshold =
                        (oldValue <= threshold + epsilon && value > threshold + epsilon) ||
                        (oldValue > threshold + epsilon && value <= threshold + epsilon);

                    if (crossedThreshold) {
                        // 如果跨越了阈值，只记录一次日志
                        // 使用静态变量记录上次跨越阈值的时间，避免短时间内重复输出
                        const now = Date.now();
                        if (!ImageCaption._lastThresholdCrossTime || now - ImageCaption._lastThresholdCrossTime > 500) {
                            logger.log(`[图像小助手-缩放监听] 跨越阈值 | 旧值: ${oldValue.toFixed(4)} | 新值: ${value.toFixed(4)} | 阈值: ${threshold}`);
                            ImageCaption._lastThresholdCrossTime = now;
                        }
                    }

                    // 无论是否跨越阈值，都立即更新
                    immediateUpdate();

                    // 多次检查确保状态正确应用
                    setTimeout(immediateUpdate, 10);
                    setTimeout(immediateUpdate, 50);
                    setTimeout(() => {
                        // 更新所有已存在的图像小助手实例
                        ImageCaption.instances.forEach((instance) => {
                            if (instance && instance.node) {
                                imageCaption.updateAssistantVisibility(instance);
                            }
                        });
                    }, 100);
                },
                configurable: true
            });

            // 添加清理函数
            assistant._eventCleanupFunctions.push(() => {
                if (app.canvas && app.canvas.ds) {
                    Object.defineProperty(app.canvas.ds, 'scale', originalDSScale);
                }
            });
        }
    }

    /**
     * 设置展开折叠事件
     */
    _setupCollapseExpandEvents(assistant) {
        // Event handling is delegated to AssistantContainer
    }



    /**
     * 设置按钮右键菜单
     * @param {HTMLElement} button 按钮元素
     * @param {Function} getMenuItems 获取菜单项的函数
     * @param {Object} assistant 小助手实例
     */
    _setupButtonContextMenu(button, getMenuItems, assistant) {
        if (!button || typeof getMenuItems !== 'function') return;

        // 确保assistant对象具有正确的类型标识，方便右键菜单关闭时识别
        assistant.type = 'image_caption_assistant';

        const cleanup = buttonMenu.setupButtonMenu(button, () => {
            return getMenuItems(assistant);
        }, { widget: assistant, buttonElement: button }); // 传递正确的上下文

        if (cleanup) {
            assistant._eventCleanupFunctions = assistant._eventCleanupFunctions || [];
            assistant._eventCleanupFunctions.push(cleanup);
        }
    }

    // ---静态方法---
    /**
     * 添加实例到管理器
     */
    static addInstance(nodeId, assistant) {
        if (nodeId != null && assistant != null) {
            this.instances.set(String(nodeId), assistant);
            return true;
        }
        return false;
    }

    /**
     * 获取实例
     */
    static getInstance(nodeId) {
        if (nodeId == null) return null;

        // 确保nodeId是字符串类型
        const key = String(nodeId);
        const instance = this.instances.get(key);


        return instance;
    }

    /**
     * 检查实例是否存在
     */
    static hasInstance(nodeId) {
        if (nodeId == null) return false;
        // 确保nodeId是字符串类型
        return this.instances.has(String(nodeId));
    }

    /**
     * 清理小助手实例
     * @param {string|null} nodeId - 节点ID，如果为null则清理所有实例
     * @param {boolean} silent - 是否静默清理（不输出日志）
     */
    cleanup(nodeId = null, silent = false) {
        // 如果正在切换工作流，完全清理图像小助手实例
        if (window.PROMPT_ASSISTANT_WORKFLOW_SWITCHING) {
            // 简化日志：工作流切换期间不逐条打印节点清理日志

            if (nodeId === null) {
                // 清理所有实例，并从集合中移除
                const instanceCount = ImageCaption.instances.size;
                if (instanceCount > 0) {
                    ImageCaption.instances.forEach((assistant, id) => {
                        this._cleanupSingleInstance(assistant);
                    });
                    // 清空实例集合
                    ImageCaption.instances.clear();
                }
            } else {
                // 清理特定节点实例
                const searchId = String(nodeId);
                const keysToDelete = Array.from(ImageCaption.instances.keys())
                    .filter(key => key === searchId || key.startsWith(`${searchId}_`));

                keysToDelete.forEach(key => {
                    const assistant = ImageCaption.instances.get(key);
                    if (assistant) {
                        this._cleanupSingleInstance(assistant);
                        ImageCaption.instances.delete(key);
                    }
                });
            }

            return;
        }

        try {
            if (nodeId === null) {
                // 清理所有实例
                const instanceCount = ImageCaption.instances.size;
                if (instanceCount > 0) {
                    ImageCaption.instances.forEach((assistant, id) => {
                        this._cleanupSingleInstance(assistant);
                    });
                    ImageCaption.instances.clear();
                    if (!silent) {
                        logger.log(`清理所有图像小助手实例 | 数量: ${instanceCount}`);
                    }
                }
            } else {
                // 清理指定节点的所有实例
                const searchId = String(nodeId);
                const keysToDelete = Array.from(ImageCaption.instances.keys())
                    .filter(key => key === searchId || key.startsWith(`${searchId}_`));

                keysToDelete.forEach(key => {
                    const assistant = ImageCaption.instances.get(key);
                    if (assistant) {
                        this._cleanupSingleInstance(assistant);
                        ImageCaption.instances.delete(key);
                        if (!silent) {
                            logger.log(`清理图像小助手实例 | 键: ${key}`);
                        }
                    }
                });
            }
        } catch (error) {
            logger.error(`清理图像小助手实例失败 | ${error.message}`);
        }
    }

    /**
     * 清理单个实例的内部方法
     * @param {object} assistant - 小助手实例
     */
    _cleanupSingleInstance(assistant) {
        if (!assistant) return;

        // 标记实例为已销毁
        assistant.isDestroyed = true;

        try {
            // 清理DOM元素
            if (assistant.element && assistant.element.parentNode) {
                assistant.element.parentNode.removeChild(assistant.element);
            }

            // 清理事件监听器
            if (assistant._eventCleanupFunctions && Array.isArray(assistant._eventCleanupFunctions)) {
                assistant._eventCleanupFunctions.forEach(cleanup => {
                    if (typeof cleanup === 'function') {
                        cleanup();
                    }
                });
                assistant._eventCleanupFunctions = [];
            }

            // 清理定时器
            if (assistant._timers) {
                Object.values(assistant._timers).forEach(timer => {
                    if (timer) {
                        clearTimeout(timer);
                    }
                });
                assistant._timers = {};
            }

            if (assistant._imageDetectionTimer) {
                clearTimeout(assistant._imageDetectionTimer);
                assistant._imageDetectionTimer = null;
            }

            // 清理引用（node 属性为动态 getter，无需手动清理）
            assistant.element = null;
            assistant.innerContent = null;
            assistant.hoverArea = null;
            assistant.indicator = null;
            assistant.buttons = {};
        } catch (error) {
            logger.error(`清理单个实例失败 | ${error.message}`);
        }
    }

    /**
     * 统一控制总开关功能
     */
    async toggleGlobalFeature(enable, force = false) {
        // 更新状态
        const oldValue = window.FEATURES.imageCaption;
        window.FEATURES.imageCaption = enable;

        // 状态未变化时不执行操作，除非force为true
        if (!force && oldValue === enable) {
            return;
        }

        // 仅当状态变化或强制执行时才记录日志
        if (oldValue !== enable || force) {
            logger.log(`图像反推功能 | 动作:${enable ? "启用" : "禁用"}`);
        }

        try {
            if (enable) {
                // === 启用图像反推功能 ===
                // 确保管理器已初始化
                if (!EventManager.initialized) {
                    EventManager.init();
                }

                // 1. 重置节点初始化标记，准备重新检测
                if (app.canvas && app.canvas.graph) {
                    const nodes = app.canvas.graph._nodes || [];
                    nodes.forEach(node => {
                        if (node) {
                            node._imageCaptionInitialized = false;
                        }
                    });

                    // 2. 如果开启了自动创建，立即扫描所有有效节点
                    const icCreationMode = app.ui.settings.getSettingValue("PromptAssistant.Settings.ImageCaptionCreationMode") || "auto";
                    if (icCreationMode === "auto") {
                        nodes.forEach(node => {
                            if (node && this.hasValidImage(node) && !node._imageCaptionInitialized) {
                                node._imageCaptionInitialized = true;
                                this.checkAndSetupNode(node);
                            }
                        });
                    }
                }

                // 3. 设置或恢复节点选择事件监听
                this.registerNodeSelectionListener();

                // 4. 检查当前选中的节点
                if (app.canvas && app.canvas.selected_nodes) {
                    app.canvas._imageCaptionSelectionHandler(app.canvas.selected_nodes);
                }
            } else {
                // === 禁用图像反推功能 ===
                // 1. 清理所有实例
                this.cleanup(null, true);
            }

            // 更新按钮可见性
            if (window.FEATURES.updateButtonsVisibility) {
                window.FEATURES.updateButtonsVisibility();
            }
        } catch (error) {
            logger.error(`图像小助手功能开关操作失败 | 错误: ${error.message}`);
        }
    }

    /**
     * 更新所有实例的预设尺寸
     * 当功能开关或配置变更时调用，触发容器的常量布局计算逻辑
     */
    updateAllInstancesWidth() {
        logger.debug(`[图像小助手] 触发所有实例尺寸重算 | 实例数量: ${ImageCaption.instances.size}`);

        ImageCaption.instances.forEach((assistant) => {
            if (assistant && assistant.container && typeof assistant.container.updateDimensions === 'function') {
                assistant.container.updateDimensions();
            }
        });
    }

}

// 创建单例实例
const imageCaption = new ImageCaption();


// 导出
export { imageCaption, ImageCaption };