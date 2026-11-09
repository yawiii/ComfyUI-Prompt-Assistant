/**
 * 小助手设置服务
 * 负责管理小助手的设置选项，提供开关控制功能
 */

import { app } from "../../../../scripts/app.js";
import { logger } from '../utils/logger.js';
import { PromptAssistant } from "./PromptAssistant.js";
import { ImageCaption } from "./imageCaption.js";
import { EventManager } from "../utils/eventManager.js";
import { ResourceManager } from "../utils/resourceManager.js";
import { HistoryCacheService, TagCacheService, TranslateCacheService, CACHE_CONFIG } from "../services/cache.js";
import { UIToolkit } from "../utils/UIToolkit.js";
import { FEATURES, handleFeatureChange } from "../services/features.js";
import { APIService } from "../services/api.js";
import {
    UI_LANGUAGE_SETTING_ID,
    getStoredUiLanguage,
    persistUiLanguage,
    ensureUiLocaleLoaded,
    tUI,
    patchToastLocalization,
    syncGlobalUiLocalization,
    LANGUAGE_OPTIONS
} from "../utils/uiI18n.js";

import { apiConfigManager } from "./apiConfigManager.js";
import { rulesConfigManager } from "./rulesConfigManager.js";
import {
    createSettingsDialog,
    closeModalWithAnimation,
    createFormGroup,
    createInputGroup,
    createSelectGroup,
    createHorizontalFormGroup,
    createLoadingButton
} from "./uiComponents.js";

// 标记是否是首次加载页面
let isFirstLoad = true;

function localizeSettingsPayload(payload) {
    if (Array.isArray(payload)) {
        return payload.map(item => localizeSettingsPayload(item));
    }

    if (!payload || typeof payload !== "object") {
        return payload;
    }

    const localized = {};
    for (const [key, value] of Object.entries(payload)) {
        if (key === "category" && Array.isArray(value)) {
            localized[key] = value.map(item => tUI(item, item));
            continue;
        }

        if (["name", "tooltip", "text", "summary", "detail"].includes(key) && typeof value === "string") {
            localized[key] = tUI(value, value);
            continue;
        }

        if (typeof value === "function") {
            localized[key] = value;
            continue;
        }

        localized[key] = localizeSettingsPayload(value);
    }

    return localized;
}

// ---服务选择器配置---
const SERVICE_TYPES = {
    translate: {
        name: tUI('翻译'),
        configEndpoint: '/config/translate',
        serviceType: 'translate',
        filterKey: 'llm_models',
        includeBaidu: true
    },
    llm: {
        name: tUI('提示词优化'),
        configEndpoint: '/config/llm',
        serviceType: 'llm',
        filterKey: 'llm_models',
        includeBaidu: false
    },
    vlm: {
        name: tUI('图像反推'),
        configEndpoint: '/config/vision',
        serviceType: 'vlm',
        filterKey: 'vlm_models',
        includeBaidu: false
    }
};

// ---服务选择器---
const serviceSelector = {
    _servicesCache: null,
    _cacheTime: 0,
    _cacheDuration: 2000, // 缓存2秒

    /**
     * 清除服务缓存
     */
    clearCache() {
        this._servicesCache = null;
        this._cacheTime = 0;
        logger.debug('服务列表缓存已清除');
    },

    // 获取服务列表（带缓存）
    async getServices(forceRefresh = false) {
        const now = Date.now();
        if (!forceRefresh && this._servicesCache && (now - this._cacheTime) < this._cacheDuration) {
            return this._servicesCache;
        }

        try {
            const response = await fetch(APIService.getApiUrl('/services'));
            if (response.ok) {
                const data = await response.json();
                if (data.success) {
                    this._servicesCache = data.services || [];
                    this._cacheTime = now;
                    return this._servicesCache;
                }
            }
        } catch (error) {
            logger.error(`获取服务列表失败: ${error.message}`);
        }
        return [];
    },

    // 获取指定类型的当前服务ID
    async getCurrentService(type) {
        const config = SERVICE_TYPES[type];
        if (!config) return null;

        try {
            const response = await fetch(APIService.getApiUrl(config.configEndpoint));
            if (response.ok) {
                const data = await response.json();
                return data.provider || null;
            }
        } catch (error) {
            logger.error(`获取${config.name}当前服务失败: ${error.message}`);
        }
        return null;
    },

    // 设置指定类型的服务
    async setCurrentService(type, serviceId) {
        const config = SERVICE_TYPES[type];
        if (!config) return false;

        try {
            const response = await fetch(APIService.getApiUrl('/services/current'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    service_type: config.serviceType,
                    service_id: serviceId
                })
            });

            if (response.ok) {
                logger.log(`${config.name}服务切换 | 服务ID: ${serviceId}`);

                // 派发全局事件通知其他组件同步
                window.dispatchEvent(new CustomEvent('pa-service-changed', {
                    detail: { service_type: config.serviceType, service_id: serviceId }
                }));

                return true;
            }
        } catch (error) {
            logger.error(`切换${config.name}服务失败: ${error.message}`);
        }
        return false;
    },

    // 获取指定类型可用的服务选项列表
    async getServiceOptions(type) {
        const config = SERVICE_TYPES[type];
        if (!config) return [];

        const services = await this.getServices();
        const options = [];

        // 添加百度翻译选项（仅翻译类型）
        if (config.includeBaidu) {
            options.push({ value: 'baidu', text: tUI('百度翻译') });
        }

        // 过滤并添加其他服务
        services
            .filter(service => {
                const models = service[config.filterKey];
                return models && models.length > 0;
            })
            .forEach(service => {
                options.push({
                    value: service.id,
                    text: service.name || service.id
                });
            });

        return options;
    }
};

// 将服务选择器挂载到全局 app 对象，方便其他模块（如 PromptAssistant.js, imageCaption.js）调用，
// 同时避免模块间的循环引用问题。
app.paServiceSelector = serviceSelector;

// ---版本检查工具函数---

// 版本检查状态缓存
let versionCheckCache = {
    checked: false,        // 是否已检查过
    latestVersion: null,   // 最新版本号
    hasUpdate: false       // 是否有更新
};

/**
 * 从 jsDelivr 获取最新版本号（通过读取 pyproject.toml）
 * @returns {Promise<string|null>} 返回最新版本号，格式如 "1.2.3"，失败返回 null
 */
async function fetchLatestVersion() {
    // 如果已经检查过，直接返回缓存结果
    if (versionCheckCache.checked) {
        return versionCheckCache.latestVersion;
    }

    try {
        const response = await fetch('https://cdn.jsdelivr.net/gh/yawiii/ComfyUI-Prompt-Assistant@main/pyproject.toml', {
            cache: 'no-cache'
        });

        if (!response.ok) {
            logger.warn(`[版本检查] 请求失败: ${response.status}`);
            versionCheckCache.checked = true;
            return null;
        }

        const tomlContent = await response.text();
        const versionMatch = tomlContent.match(/^version\s*=\s*["']([^"']+)["']/m);
        const version = versionMatch ? versionMatch[1] : null;

        // 缓存检查结果
        versionCheckCache.checked = true;
        versionCheckCache.latestVersion = version;

        return version;
    } catch (error) {
        logger.warn(`[版本检查] 获取失败: ${error.message}`);
        versionCheckCache.checked = true;
        return null;
    }
}

/**
 * 比较两个版本号
 * @param {string} v1 - 第一个版本号
 * @param {string} v2 - 第二个版本号
 * @returns {number} v1 > v2 返回 1，v1 < v2 返回 -1，v1 === v2 返回 0
 */
function compareVersion(v1, v2) {
    // 将版本号分割为数字数组
    const parts1 = v1.split('.').map(n => parseInt(n, 10) || 0);
    const parts2 = v2.split('.').map(n => parseInt(n, 10) || 0);

    // 确保两个数组长度相同
    const maxLength = Math.max(parts1.length, parts2.length);

    for (let i = 0; i < maxLength; i++) {
        const num1 = parts1[i] || 0;
        const num2 = parts2[i] || 0;

        if (num1 > num2) return 1;
        if (num1 < num2) return -1;
    }

    return 0;
}


// ====================== 设置管理 ======================

/**
 * 显示API配置弹窗
 */
function showAPIConfigModal() {
    try {
        // 调用API配置管理器的显示弹窗方法
        apiConfigManager.showAPIConfigModal();
    } catch (error) {
        logger.error(`打开API配置弹窗失败: ${error.message}`);
        app.extensionManager.toast.add({
            severity: "error",
            summary: tUI("打开配置失败"),
            detail: error.message || tUI("打开配置弹窗过程中发生错误"),
            life: 3000
        });
    }
}

/**
 * 显示规则配置弹窗
 */
function showRulesConfigModal() {
    try {
        // 调用规则配置管理器的显示弹窗方法
        rulesConfigManager.showRulesConfigModal();
    } catch (error) {
        logger.error(`打开规则配置弹窗失败: ${error.message}`);
        app.extensionManager.toast.add({
            severity: "error",
            summary: tUI("打开配置失败"),
            detail: error.message || tUI("打开配置弹窗过程中发生错误"),
            life: 3000
        });
    }
}

/**
 * 创建服务选择器下拉框
 * @param {string} type - 服务类型: 'translate' | 'llm' | 'vlm'
 * @param {string} label - 显示名称
 * @returns {HTMLElement} 设置行元素
 */
function createServiceSelector(type, label) {
    const row = document.createElement("tr");
    row.className = "promptwidget-settings-row";

    const labelCell = document.createElement("td");
    labelCell.className = "comfy-menu-label";
    row.appendChild(labelCell);

    const selectCell = document.createElement("td");

    // 创建加载占位容器
    const container = document.createElement("div");
    container.style.minWidth = "180px";
    container.innerHTML = `<span style="color: var(--p-text-muted-color); font-size: 12px;">${tUI("加载中...")}</span>`;

    selectCell.appendChild(container);
    row.appendChild(selectCell);

    let currentOptions = []; // 存储当前选项引用
    let updateDropdownOptions = null; // 存储更新函数

    /**
     * 更新下拉框内容
     * @param {boolean} force - 是否强制刷新数据
     */
    const updateContent = async (force = false) => {
        try {
            if (force) {
                // 如果是强制刷新（如配置变更或点击触发），先清除缓存
                serviceSelector.clearCache();
            }

            // 获取服务列表和当前选中的服务
            const [options, currentService] = await Promise.all([
                serviceSelector.getServiceOptions(type),
                serviceSelector.getCurrentService(type)
            ]);

            // 如果已经存在下拉框实例，则尝试增量更新
            if (updateDropdownOptions) {
                updateDropdownOptions(options, currentService);
                currentOptions = options;
                return;
            }

            // ---首次加载逻辑---
            container.innerHTML = '';

            if (options.length === 0) {
                container.innerHTML = `<span style="color: var(--p-text-muted-color); font-size: 12px;">${tUI("暂无可用服务")}</span>`;
                return;
            }

            currentOptions = options;
            const res = createSelectGroup(label, options, currentService, { showLabel: false });
            const { group, select } = res;
            updateDropdownOptions = res.updateOptions;

            // 将 group 的子元素添加到容器
            while (group.firstChild) {
                container.appendChild(group.firstChild);
            }

            // 监听点击/按下事件：当用户准备点击下拉框时，尝试静默同步最新配置
            const dropdownContainer = container.querySelector('.pa-dropdown');
            if (dropdownContainer) {
                dropdownContainer.addEventListener('mousedown', () => {
                    // 点击时触发刷新，但不显示“同步中”以避免干扰 UI
                    updateContent(true);
                });
            }

            // 监听变更事件
            select.addEventListener('change', async () => {
                const newValue = select.value;
                if (!newValue) return;

                const dropdown = container.querySelector('.pa-dropdown');
                if (dropdown) {
                    dropdown.style.opacity = '0.6';
                    dropdown.style.pointerEvents = 'none';
                }

                try {
                    const success = await serviceSelector.setCurrentService(type, newValue);
                    if (success) {
                        logger.log(`设置${label}服务 | 服务: ${newValue}`);
                    } else {
                        logger.error(`设置${label}服务失败`);
                        const oldValue = await serviceSelector.getCurrentService(type);
                        if (oldValue && updateDropdownOptions) {
                            updateDropdownOptions(currentOptions, oldValue);
                        }
                    }
                } catch (error) {
                    logger.error(`设置${label}服务异常: ${error.message}`);
                } finally {
                    if (dropdown) {
                        dropdown.style.opacity = '';
                        dropdown.style.pointerEvents = '';
                    }
                }
            });

        } catch (error) {
            logger.error(`同步${label}配置失败: ${error.message}`);
            if (!updateDropdownOptions) {
                container.innerHTML = `<span style="color: var(--p-red-400); font-size: 12px;">${tUI("加载失败")}</span>`;
            }
        }
    };

    // 初始加载
    updateContent();

    // 监听配置更新事件（当 API 配置管理器修改配置后触发）
    const onConfigUpdated = () => {
        logger.debug(`收到配置更新通知，同步${label}状态...`);
        updateContent(true);
    };
    window.addEventListener('pa-config-updated', onConfigUpdated);

    // 销毁监听器的清理函数（简单处理，因为设置面板通常随页面销毁）
    // 如果之后有更复杂的组件挂载逻辑，可以在这里返回一个清理函数给外部调用

    return row;
}


/**
 * 注册设置选项
 * 将设置选项添加到ComfyUI设置面板
 */
export async function registerSettings() {
    try {
        await ensureUiLocaleLoaded();
        patchToastLocalization();
        syncGlobalUiLocalization();

        app.registerExtension({
            name: "PromptAssistant.Settings",
            settings: localizeSettingsPayload([
                {
                    id: UI_LANGUAGE_SETTING_ID,
                    name: "界面语言",
                    category: ["✨提示词小助手", "系统", "界面语言"],
                    type: "combo",
                    options: LANGUAGE_OPTIONS,
                    defaultValue: "zh",
                    tooltip: "切换插件界面语言，修改后自动刷新页面生效",
                    onChange: (value) => {
                        const previous = getStoredUiLanguage();
                        const normalized = persistUiLanguage(value);
                        if (normalized === previous) return;
                        logger.log(`界面语言已切换: ${normalized}`);
                        setTimeout(() => window.location.reload(), 80);
                    }
                },
                // 总开关 - 独立控制小助手系统级功能
                {
                    id: "PromptAssistant.Features.Enabled",
                    name: "启用小助手",
                    category: ["✨提示词小助手", "小助手功能开关", "总开关"],
                    type: "boolean",
                    defaultValue: true,
                    tooltip: "关闭后，提示词小助手所有功能将禁用",
                    onChange: async (value) => {
                        try {
                            // 获取当前状态，用于判断是否是初始化
                            const currentState = window.FEATURES.enabled;

                            // 只有状态真正变化时才输出日志
                            if (currentState !== value) {
                                logger.log(`总开关状态变更 | 状态:${value ? "启用" : "禁用"}`);
                            } else {
                                // 如果状态没有变化，使用调试级别日志
                                logger.debug(`总开关状态保持不变 | 状态:${value ? "启用" : "禁用"}`);
                            }

                            // 更新全局状态
                            window.FEATURES.enabled = value;

                            // 从全局 app 对象获取 promptAssistant 实例
                            const promptAssistantInstance = app.promptAssistant;
                            const imageCaptionInstance = app.imageCaption;

                            if (!promptAssistantInstance) {
                                logger.error("总开关切换失败 | 错误:未找到PromptAssistant实例");
                                return;
                            }

                            // 根据开关状态执行相应操作
                            if (value) {
                                // 启用功能
                                await promptAssistantInstance.toggleGlobalFeature(true, currentState !== value);
                                if (imageCaptionInstance) {
                                    await imageCaptionInstance.toggleGlobalFeature(true, currentState !== value);
                                }

                                // 只在状态真正变化且不是首次加载时记录日志和显示提示
                                if (currentState !== value) {
                                    logger.debug("功能启用完成");
                                    // 只在状态发生变化且不是首次加载时显示提示
                                    if (!isFirstLoad) {
                                        app.extensionManager.toast.add({
                                            severity: "info",
                                            summary: tUI("提示词小助手已启用"),
                                            life: 3000
                                        });
                                    }
                                }
                            } else {
                                // 禁用功能
                                await promptAssistantInstance.toggleGlobalFeature(false, currentState !== value);
                                if (imageCaptionInstance) {
                                    await imageCaptionInstance.toggleGlobalFeature(false, currentState !== value);
                                }

                                // 只在状态真正变化且不是首次加载时记录日志和显示提示
                                if (currentState !== value) {
                                    logger.debug("功能禁用完成");
                                    // 只在状态发生变化且不是首次加载时显示提示
                                    if (!isFirstLoad) {
                                        app.extensionManager.toast.add({
                                            severity: "warn",
                                            summary: tUI("提示词小助手已禁用"),
                                            life: 3000
                                        });
                                    }
                                }
                            }

                            // 设置首次加载标志为 false，表示已经完成首次加载
                            isFirstLoad = false;
                        } catch (error) {
                            logger.error(`总开关切换异常 | 错误:${error.message}`);
                        }
                    }
                },

                // 小助手创建方式设置
                {
                    id: "PromptAssistant.Settings.CreationMode",
                    name: "小助手创建方式（提示词）",
                    category: ["✨提示词小助手", "系统", "提示词小助手创建方式"],
                    type: "combo",
                    options: [
                        { text: "自动创建", value: "auto" },
                        { text: "选中节点时创建", value: "manual" }
                    ],
                    defaultValue: "auto",
                    tooltip: "自动创建：节点创建或加载时自动显示小助手；选中节点时创建：仅选中节点时显示",
                    onChange: (value) => {
                        logger.log(`小助手创建方式变更 | 模式:${value === 'auto' ? '自动创建' : '选中节点时创建'}`);
                        // 如果切换到自动创建，立即尝试初始化所有节点
                        if (value === 'auto' && window.FEATURES.enabled && app.graph) {
                            const nodes = app.graph._nodes || [];
                            nodes.forEach(node => {
                                if (node && !node._promptAssistantInitialized) {
                                    app.promptAssistant.checkAndSetupNode(node);
                                }
                            });
                        }
                    }
                },

                // 反推小助手创建方式设置
                {
                    id: "PromptAssistant.Settings.ImageCaptionCreationMode",
                    name: "小助手创建方式（图像反推）",
                    category: ["✨提示词小助手", "系统", "图像小助手创建方式"],
                    type: "combo",
                    options: [
                        { text: "自动创建", value: "auto" },
                        { text: "选中节点时创建", value: "manual" }
                    ],
                    defaultValue: "auto",
                    tooltip: "自动创建：节点创建或加载时自动显示反推小助手；选中节点时创建：仅选中节点时显示",
                    onChange: (value) => {
                        logger.log(`反推小助手创建方式变更 | 模式:${value === 'auto' ? '自动创建' : '选中节点时创建'}`);
                        // 如果切换到自动创建，立即尝试初始化所有节点
                        if (value === 'auto' && window.FEATURES.enabled && window.FEATURES.imageCaption && app.graph) {
                            const nodes = app.graph._nodes || [];
                            nodes.forEach(node => {
                                if (node && !node._imageCaptionInitialized) {
                                    app.imageCaption.checkAndSetupNode(node);
                                }
                            });
                        }
                    }
                },

                // 小助手布局（提示词）
                {
                    id: "PromptAssistant.Location",
                    name: "小助手布局（提示词）",
                    category: ["✨提示词小助手", "界面", "提示词小助手布局"],
                    type: "combo",
                    options: [
                        // { text: "左上（横向）", value: "top-left-h" },
                        // { text: "左上（垂直）", value: "top-left-v" },
                        // { text: "中上（横向）", value: "top-center-h" },
                        // { text: "⇗ ━", value: "top-right-h" },
                        // { text: "⇗ ┃", value: "top-right-v" },
                        { text: "右中（垂直）", value: "right-center-v" },
                        { text: "右下（横向）", value: "bottom-right-h" },
                        { text: "右下（垂直）", value: "bottom-right-v" },
                        { text: "下中（横向）", value: "bottom-center-h" },
                        { text: "左下（横向）", value: "bottom-left-h" },
                        // { text: "左下（垂直）", value: "bottom-left-v" },
                        // { text: "左中（垂直）", value: "left-center-v" }
                    ],
                    defaultValue: "bottom-right-h", // 默认右下横向
                    tooltip: "设置提示词小助手在输入框周围的布局和展开方向",
                    onChange: (value) => {
                        logger.log(`提示词小助手布局变更 | 布局:${value}`);
                        // 通知所有实例更新布局（通过 CSS 类处理）
                        PromptAssistant.instances.forEach(widget => {
                            if (widget.container && widget.container.setAnchorPosition) {
                                widget.container.setAnchorPosition(value);
                            }
                        });
                    }
                },
                // 小助手位置设置（图像反推）
                {
                    id: "ImageCaption.Location",
                    name: "小助手布局（图像反推）",
                    category: ["✨提示词小助手", "界面", "图像小助手布局"],
                    type: "combo",
                    options: [
                        { text: "横", value: "bottom-left-h" },
                        { text: "竖", value: "bottom-left-v" }
                    ],
                    defaultValue: "bottom-left-h", // 默认横向
                    tooltip: "设置图像反推小助手的展开方向（位置固定在左下角）",
                    onChange: (value) => {
                        logger.log(`图像反推小助手布局变更 | 布局:${value}`);
                        // 通知所有实例更新布局
                        ImageCaption.instances.forEach(assistant => {
                            if (assistant.container && assistant.container.setAnchorPosition) {
                                assistant.container.setAnchorPosition(value);
                            }
                        });
                    },
                },

                // API 配置按钮
                {
                    id: "PromptAssistant.Features.APIConfig",
                    name: "百度和大语言模型API配置",
                    category: ["✨提示词小助手", " 配置", "API配置"],
                    tooltip: "配置或修改API信息",
                    type: () => {
                        const row = document.createElement("tr");
                        row.className = "promptwidget-settings-row";

                        const labelCell = document.createElement("td");
                        labelCell.className = "comfy-menu-label";
                        row.appendChild(labelCell);

                        const buttonCell = document.createElement("td");
                        const button = createLoadingButton(tUI("API管理器"), async () => {
                            showAPIConfigModal();
                        }, false); // 设置 showSuccessToast 为 false

                        buttonCell.appendChild(button);
                        row.appendChild(buttonCell);
                        return row;
                    }
                },

                // ---服务类别设置---
                // 翻译服务选择
                {
                    id: "PromptAssistant.Service.Translate",
                    name: "选择翻译服务",
                    category: ["✨提示词小助手", " 配置", "翻译"],
                    tooltip: "选择一个服务商用于翻译，也可以通过右键翻译按钮来切换",
                    type: () => {
                        return createServiceSelector('translate', '翻译');
                    }
                },

                // 提示词优化服务选择
                {
                    id: "PromptAssistant.Service.LLM",
                    name: "选择提示词优化服务",
                    category: ["✨提示词小助手", " 配置", "提示词优化"],
                    tooltip: "选择一个服务商用于提示词优化，也可以通过右键提示词优化按钮来切换",
                    type: () => {
                        return createServiceSelector('llm', '提示词优化');
                    }
                },

                // 图像反推服务选择
                {
                    id: "PromptAssistant.Service.VLM",
                    name: "选择图像反推服务",
                    category: ["✨提示词小助手", " 配置", "图像反推"],
                    tooltip: "选择一个服务商用于图像反推，也可以通过右键反推按钮来切换",
                    type: () => {
                        return createServiceSelector('vlm', '图像反推');
                    }
                },

                // 历史功能（包含历史、撤销、重做按钮）
                {
                    id: "PromptAssistant.Features.History",
                    name: "启用历史功能",
                    category: ["✨提示词小助手", "小助手功能开关", "历史功能"],
                    type: "boolean",
                    defaultValue: true,
                    tooltip: "开启或关闭历史、撤销、重做功能",
                    onChange: (value) => {
                        const oldValue = FEATURES.history;
                        FEATURES.history = value;
                        handleFeatureChange('历史功能', value, oldValue);
                        logger.log(`历史功能 - 已${value ? "启用" : "禁用"}`);
                    }
                },

                // 标签工具
                {
                    id: "PromptAssistant.Features.Tag",
                    name: "启用标签工具",
                    category: ["✨提示词小助手", "小助手功能开关", "标签功能"],
                    type: "boolean",
                    defaultValue: true,
                    tooltip: "开启或关闭标签工具功能",
                    onChange: (value) => {
                        const oldValue = FEATURES.tag;
                        FEATURES.tag = value;
                        handleFeatureChange('标签工具', value, oldValue);
                        logger.log(`标签工具 - 已${value ? "启用" : "禁用"}`);
                    }
                },

                // 扩写功能
                {
                    id: "PromptAssistant.Features.Expand",
                    name: "启用提示词优化功能",
                    category: ["✨提示词小助手", "小助手功能开关", "提示词优化功能"],
                    type: "boolean",
                    defaultValue: true,
                    tooltip: "开启或关闭提示词优化功能",
                    onChange: (value) => {
                        const oldValue = FEATURES.expand;
                        FEATURES.expand = value;
                        handleFeatureChange('提示词优化功能', value, oldValue);
                        logger.log(`提示词优化功能 - 已${value ? "启用" : "禁用"}`);
                    }
                },

                // 翻译功能
                {
                    id: "PromptAssistant.Features.Translate",
                    name: "启用翻译功能",
                    category: ["✨提示词小助手", "小助手功能开关", "翻译功能"],
                    type: "boolean",
                    defaultValue: true,
                    tooltip: "开启或关闭翻译功能",
                    onChange: (value) => {
                        const oldValue = FEATURES.translate;
                        FEATURES.translate = value;
                        handleFeatureChange('翻译功能', value, oldValue);
                        logger.log(`翻译功能 - 已${value ? "启用" : "禁用"}`);
                    }
                },

                // 使用翻译缓存功能
                {
                    id: "PromptAssistant.Features.UseTranslateCache",
                    name: "使用翻译缓存",
                    category: ["✨提示词小助手", " 翻译功能设置", "翻译缓存"],
                    type: "boolean",
                    defaultValue: true,
                    tooltip: "开启后，如果翻译内容翻译过，则使用历史翻译结果，避免相同内容重复翻译改变原意。如果需要重新翻译，请随便加一个空格即可跳过缓存。",
                    onChange: (value) => {
                        const oldValue = FEATURES.useTranslateCache;
                        FEATURES.useTranslateCache = value;
                        logger.log(`使用翻译缓存 - 已${value ? "启用" : "禁用"}`);
                    }
                },

                // 混合语言缓存选项
                {
                    id: "PromptAssistant.Features.CacheMixedLangTranslation",
                    name: "混合语言翻译进行缓存",
                    category: ["✨提示词小助手", " 翻译功能设置", "混合语言缓存"],
                    type: "boolean",
                    defaultValue: false,
                    tooltip: "关闭时，中英文混合内容的翻译结果不会写入缓存，避免污染缓存。开启后会正常缓存。",
                    onChange: (value) => {
                        FEATURES.cacheMixedLangTranslation = value;
                        logger.log(`混合语言缓存 - 已${value ? "启用" : "禁用"}`);
                    }
                },

                // 混合语言翻译规则
                {
                    id: "PromptAssistant.Features.MixedLangTranslateRule",
                    name: "混合语言翻译规则",
                    category: ["✨提示词小助手", " 翻译功能设置", "混合语言规则"],
                    type: "combo",
                    options: [
                        { text: "翻译成英文", value: "to_en" },
                        { text: "翻译成中文", value: "to_zh" },
                        { text: "自动翻译小比例语言", value: "auto_minor" },
                        { text: "自动翻译大比例语言", value: "auto_major" }
                    ],
                    defaultValue: "to_en",
                    tooltip: "根据个人使用偏好设置混合中英文内容的翻译规则",
                    onChange: (value) => {
                        FEATURES.mixedLangTranslateRule = value;
                        logger.log(`混合语言翻译规则 - 已设置为:${value}`);
                    }
                },

                // Целевой язык кнопки «Перевод» у текстовых полей (RU-fork)
                {
                    id: "PromptAssistant.Features.TranslateTargetLang",
                    name: "Целевой язык кнопки перевода",
                    category: ["✨提示词小助手", " 翻译功能设置", "Целевой язык перевода"],
                    type: "combo",
                    options: [
                        { text: "Авто (по языку интерфейса)", value: "auto" },
                        { text: "Переводить на русский", value: "ru" },
                        { text: "Переводить на английский", value: "en" },
                        { text: "Переводить на китайский", value: "zh" }
                    ],
                    defaultValue: "auto",
                    tooltip: "Определяет направление кнопки «Перевод» у текстовых полей: Авто — английский/китайский текст переводится на русский при русской локали, русский — на английский. Можно задать язык принудительно.",
                    onChange: (value) => {
                        FEATURES.translateTargetLang = value;
                        logger.log(`TranslateTargetLang - 已设置为:${value}`);
                    }
                },

                // 翻译格式化选项
                {
                    id: "PromptAssistant.Features.TranslateFormatPunctuation",
                    name: "始终使用半角标点符号",
                    category: ["✨提示词小助手", " 翻译功能设置", "标点处理"],
                    type: "boolean",
                    defaultValue: false,
                    tooltip: "打开后，翻译结果会自动将中文标点符号替换成英文标点符号",
                    onChange: (value) => {
                        FEATURES.translateFormatPunctuation = value;
                        logger.log(`标点符号转换 - 已${value ? "启用" : "禁用"}`);
                    }
                },
                {
                    id: "PromptAssistant.Features.TranslateFormatSpace",
                    name: "自动移除多余空格",
                    category: ["✨提示词小助手", " 翻译功能设置", "空格处理"],
                    type: "boolean",
                    defaultValue: false,
                    tooltip: "打开后，翻译结果会自动移除多余空格",
                    onChange: (value) => {
                        FEATURES.translateFormatSpace = value;
                        logger.log(`移除多余空格 - 已${value ? "启用" : "禁用"}`);
                    }
                },
                {
                    id: "PromptAssistant.Features.TranslateFormatDots",
                    name: "移除多余连续点号",
                    category: ["✨提示词小助手", " 翻译功能设置", "点号处理"],
                    type: "boolean",
                    defaultValue: false,
                    tooltip: "打开后，翻译结果会将多余的“......”统一为“...”",
                    onChange: (value) => {
                        FEATURES.translateFormatDots = value;
                        logger.log(`处理连续点号 - 已${value ? "启用" : "禁用"}`);
                    }
                },
                {
                    id: "PromptAssistant.Features.TranslateFormatNewline",
                    name: "保留换行符",
                    category: ["✨提示词小助手", " 翻译功能设置", "换行处理"],
                    type: "boolean",
                    defaultValue: true,
                    tooltip: "打开后，翻译结果会尽量保持原文的换行，避免翻译后丢失段落",
                    onChange: (value) => {
                        FEATURES.translateFormatNewline = value;
                        logger.log(`保留换行符 - 已${value ? "启用" : "禁用"}`);
                    }
                },



                // 图像反推功能
                {
                    id: "PromptAssistant.Features.ImageCaption",
                    name: "启用图像反推功能",
                    category: ["✨提示词小助手", "小助手功能开关", "图像反推"],
                    type: "boolean",
                    defaultValue: true,
                    tooltip: "开启或关闭图像反推提示词功能",
                    onChange: (value) => {
                        const oldValue = FEATURES.imageCaption;
                        FEATURES.imageCaption = value;
                        handleFeatureChange('图像反推', value, oldValue);
                        logger.log(`图像反推功能 - 已${value ? "启用" : "禁用"}`);
                    }
                },

                // 节点帮助翻译功能
                {
                    id: "PromptAssistant.Features.NodeHelpTranslator",
                    name: "启用节点信息翻译",
                    category: ["✨提示词小助手", "小助手功能开关", "节点信息翻译"],
                    type: "boolean",
                    defaultValue: true,
                    tooltip: "开启或关闭ComfyUI侧边栏节点帮助文档的翻译功能",
                    onChange: (value) => {
                        const oldValue = FEATURES.nodeHelpTranslator;
                        FEATURES.nodeHelpTranslator = value;
                        handleFeatureChange('节点信息翻译', value, oldValue);
                        logger.log(`节点信息翻译功能 - 已${value ? "启用" : "禁用"}`);
                    }
                },
                // 系统设置
                {
                    id: "PromptAssistant.Settings.LogLevel",
                    name: "日志级别",
                    category: ["✨提示词小助手", "系统", "日志级别"],
                    type: "hidden",
                    defaultValue: "0",
                    options: [
                        { text: "错误日志", value: "0" },
                        { text: "基础日志", value: "1" },
                        { text: "详细日志", value: "2" }
                    ],
                    tooltip: "设置日志输出级别：错误日志(仅错误)、基础日志(错误+基础信息)、详细日志(错误+基础信息+调试信息)",
                    onChange: (value) => {
                        const oldValue = window.FEATURES.logLevel;
                        window.FEATURES.logLevel = parseInt(value);
                        logger.setLevel(window.FEATURES.logLevel);
                        logger.log(`日志级别已更新 | 原级别:${oldValue} | 新级别:${value}`);
                    }
                },

                // 显示流式输出进度
                {
                    id: "PromptAssistant.Settings.ShowStreamingProgress",
                    name: "控制台流式输出进度日志",
                    category: ["✨提示词小助手", "系统", "终端日志"],
                    type: "boolean",
                    defaultValue: false,
                    tooltip: "开启后，控制台会显示流式输出过程，在某些终端可能导致刷屏；关闭后只显示静态的'生成中...'。",
                    onChange: async (value) => {
                        FEATURES.showStreamingProgress = value;
                        // 通知后端更新设置
                        try {
                            await fetch(APIService.getApiUrl('/settings/streaming_progress'), {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ enabled: value })
                            });
                        } catch (error) {
                            logger.error(`更新流式进度设置失败: ${error.message}`);
                        }
                        logger.log(`流式输出进度 - 已${value ? "启用" : "禁用"}`);
                    }
                },

                // 流式输出开关
                {
                    id: "PromptAssistant.Settings.EnableStreaming",
                    name: "流式输出开关",
                    category: ["✨提示词小助手", "系统", "流式体验"],
                    type: "boolean",
                    defaultValue: true,
                    tooltip: "开启时，翻译、扩写、识别等功能将以逐字生成的流式效果显示；关闭时则恢复为全部生成后一次性显示的阻塞模式。",
                    onChange: (value) => {
                        FEATURES.enableStreaming = value;
                        logger.log(`流式输出开关 - 已${value ? "启用" : "禁用"}`);
                    }
                },

                {
                    id: "PromptAssistant.Settings.IconOpacity",
                    name: " 小助手图标不透明度",
                    category: ["✨提示词小助手", "界面", "小助手图标"],
                    type: "slider",
                    min: 0,
                    max: 100,
                    step: 1,
                    defaultValue: 20,
                    tooltip: "设置折叠后小助手图标的不透明度",
                    onChange: (value) => {
                        // 将0-100的值转换为0-1的透明度
                        const opacity = value * 0.01;
                        document.documentElement.style.setProperty('--assistant-icon-opacity', opacity);
                        logger.log(`小助手图标不透明度已更新 | 值:${value}% | 透明度:${opacity}`);
                    },
                    onLoad: (value) => {
                        // 初始化时应用默认值
                        const opacity = value * 0.01;
                        document.documentElement.style.setProperty('--assistant-icon-opacity', opacity);
                        logger.debug(`小助手图标不透明度初始化 | 值:${value}% | 透明度:${opacity}`);
                    }
                },

                {
                    id: "PromptAssistant.Settings.ClearCache",
                    name: "清理历史、标签、翻译缓存",
                    category: ["✨提示词小助手", "系统", "清理缓存"],
                    tooltip: "清理所有缓存，包括历史记录、标签、翻译缓存、节点文档翻译缓存",
                    type: () => {
                        const row = document.createElement("tr");
                        row.className = "promptwidget-settings-row";

                        const labelCell = document.createElement("td");
                        labelCell.className = "comfy-menu-label";
                        row.appendChild(labelCell);

                        const buttonCell = document.createElement("td");
                        const button = createLoadingButton(tUI("清理所有缓存"), async () => {
                            try {
                                // 获取清理前的缓存统计
                                const beforeStats = {
                                    history: HistoryCacheService.getHistoryStats(),
                                    tags: 0,
                                    translate: TranslateCacheService.getTranslateCacheStats(),
                                    nodeHelpTranslate: 0 // 节点文档翻译缓存
                                };

                                // 统计所有标签数量
                                const tagCacheKeys = Object.keys(localStorage)
                                    .filter(key => key.startsWith(CACHE_CONFIG.TAG_KEY_PREFIX));

                                // 计算所有缓存中的标签总数
                                tagCacheKeys.forEach(key => {
                                    try {
                                        const cacheData = JSON.parse(localStorage.getItem(key));
                                        if (cacheData && typeof cacheData === 'object') {
                                            // 获取缓存中的标签数量
                                            const tagCount = Object.keys(cacheData).length;
                                            beforeStats.tags += tagCount;
                                        }
                                    } catch (e) {
                                        // 移除错误日志，静默处理解析错误
                                    }
                                });

                                // 统计节点文档翻译缓存数量
                                try {
                                    const nodeHelpCache = sessionStorage.getItem('pa_node_help_translations');
                                    if (nodeHelpCache) {
                                        const parsed = JSON.parse(nodeHelpCache);
                                        beforeStats.nodeHelpTranslate = Object.keys(parsed).length;
                                    }
                                } catch (e) {
                                    // 静默处理
                                }

                                // 执行历史记录清理操作
                                HistoryCacheService.clearAllHistory();

                                // 清理所有标签缓存
                                TagCacheService.clearAllTagCache();

                                // 清理翻译缓存
                                TranslateCacheService.clearAllTranslateCache();

                                // 清理节点文档翻译缓存（sessionStorage）
                                sessionStorage.removeItem('pa_node_help_translations');

                                // 清理旧版本的标签缓存（以PromptAssistant_tag_cache_开头的所有记录）
                                Object.keys(localStorage)
                                    .filter(key => key.startsWith('PromptAssistant_tag_cache_'))
                                    .forEach(key => localStorage.removeItem(key));

                                // 清除1.0.3以前版本遗留的三项配置信息，避免泄露
                                localStorage.removeItem("PromptAssistant_Settings_llm_api_key");
                                localStorage.removeItem("PromptAssistant_Settings_baidu_translate_secret");
                                localStorage.removeItem("PromptAssistant_Settings_baidu_translate_appid");

                                // 获取清理后的缓存统计
                                const afterStats = {
                                    history: HistoryCacheService.getHistoryStats(),
                                    tags: 0, // 清理后标签数应该为0
                                    translate: TranslateCacheService.getTranslateCacheStats()
                                };

                                // 计算清理数量
                                const clearedHistory = beforeStats.history.total - afterStats.history.total;
                                const clearedTags = beforeStats.tags;
                                const clearedTranslate = beforeStats.translate.total - afterStats.translate.total;
                                const clearedNodeHelp = beforeStats.nodeHelpTranslate;

                                // 只输出最终统计结果
                                logger.log(`缓存清理完成 | 历史记录: ${clearedHistory}条 | 标签: ${clearedTags}个 | 翻译: ${clearedTranslate}条 | 节点文档: ${clearedNodeHelp}个`);

                                // 更新所有实例的撤销/重做按钮状态
                                PromptAssistant.instances.forEach((instance) => {
                                    if (instance && instance.nodeId && instance.inputId) {
                                        UIToolkit.updateUndoRedoButtonState(instance, HistoryCacheService);
                                    }
                                });

                            } catch (error) {
                                // 简化错误日志
                                logger.error(`缓存清理失败`);
                                throw error;
                            }
                        });

                        buttonCell.appendChild(button);
                        row.appendChild(buttonCell);
                        return row;
                    }
                },



                // 关于插件信息
                {
                    id: "PromptAssistant.Settings.About",
                    name: "关于",
                    category: ["✨提示词小助手", " ✨提示词小助手"],
                    type: () => {
                        const row = document.createElement("tr");
                        row.className = "promptwidget-settings-row";
                        const cell = document.createElement("td");
                        cell.colSpan = 2;
                        cell.style.display = "flex";
                        cell.style.alignItems = "center";
                        cell.style.gap = "12px";
                        // 版本徽标容器（整体可点击跳转最新版本）
                        const versionLink = document.createElement("a");
                        versionLink.href = "https://github.com/yawiii/ComfyUI-Prompt-Assistant/releases/latest";
                        versionLink.target = "_blank";
                        versionLink.style.textDecoration = "none";
                        versionLink.style.display = "flex";
                        versionLink.style.alignItems = "center";
                        versionLink.style.cursor = "pointer";

                        const versionContainer = document.createElement("div");
                        versionContainer.style.display = "flex";
                        versionContainer.style.alignItems = "center";
                        versionContainer.style.gap = "8px";
                        versionLink.appendChild(versionContainer);

                        // 版本徽标
                        const versionBadge = document.createElement("img");
                        versionBadge.alt = "Version";
                        versionBadge.style.display = "block";
                        versionBadge.style.height = "20px";

                        // 从全局变量获取版本号
                        if (!window.PromptAssistant_Version) {
                            logger.error(tUI("未找到版本号，徽标将无法正确显示"));
                            versionBadge.src = `https://img.shields.io/badge/%E7%89%88%E6%9C%AC-%E6%9C%AA%E7%9F%A5-red?style=flat`;
                            versionContainer.appendChild(versionBadge);
                        } else {
                            const currentVersion = window.PromptAssistant_Version;
                            versionBadge.src = `https://img.shields.io/badge/%E7%89%88%E6%9C%AC-${currentVersion}-green?style=flat`;
                            versionContainer.appendChild(versionBadge);

                            // 使用缓存检查版本，避免重复请求
                            if (versionCheckCache.checked && versionCheckCache.hasUpdate) {
                                // 已检查过且有更新，直接应用缓存的结果
                                const latestVersion = versionCheckCache.latestVersion;
                                const labelEncoded = encodeURIComponent(tUI("有新版本"));
                                const messageEncoded = encodeURIComponent(`${currentVersion}→${latestVersion}`);
                                versionBadge.src = `https://img.shields.io/badge/${labelEncoded}-${messageEncoded}-orange?style=flat&labelColor=555555`;
                                versionBadge.style.cursor = "pointer";
                                versionBadge.title = `${tUI("当前版本:")} ${currentVersion}\n${tUI("最新版本:")} ${latestVersion}\n${tUI("点击前往下载")}`;
                            } else if (!versionCheckCache.checked) {
                                // 首次检查，发起异步请求
                                fetchLatestVersion().then(latestVersion => {
                                    if (latestVersion && compareVersion(latestVersion, currentVersion) > 0) {
                                        versionCheckCache.hasUpdate = true;
                                        const labelEncoded = encodeURIComponent(tUI("有新版本"));
                                        const messageEncoded = encodeURIComponent(`${currentVersion}→${latestVersion}`);
                                        versionBadge.src = `https://img.shields.io/badge/${labelEncoded}-${messageEncoded}-orange?style=flat&labelColor=555555`;
                                        versionBadge.style.cursor = "pointer";
                                        versionBadge.title = `${tUI("当前版本:")} ${currentVersion}\n${tUI("最新版本:")} ${latestVersion}\n${tUI("点击前往下载")}`;
                                        logger.log(`[版本检查] 发现新版本: ${currentVersion} → ${latestVersion}`);
                                    } else if (latestVersion) {
                                        versionBadge.title = `${tUI("当前已是最新版本:")} ${currentVersion}`;
                                        logger.debug(`[版本检查] 当前版本: ${currentVersion}`);
                                    }
                                }).catch(error => {
                                    logger.warn(`[版本检查] 出错: ${error.message}`);
                                });
                            } else {
                                // 已检查过但没有更新
                                versionBadge.title = `${tUI("当前已是最新版本:")} ${currentVersion}`;
                            }
                        }

                        cell.appendChild(versionLink);

                        // GitHub 徽标
                        const authorTag = document.createElement("a");
                        authorTag.href = "https://github.com/yawiii/ComfyUI-Prompt-Assistant";
                        authorTag.target = "_blank";
                        authorTag.style.textDecoration = "none";
                        authorTag.style.display = "flex";
                        authorTag.style.alignItems = "center";
                        const authorBadge = document.createElement("img");
                        authorBadge.alt = "Static Badge";
                        authorBadge.src = "https://img.shields.io/github/stars/yawiii/ComfyUI-Prompt-Assistant?style=flat&logo=github&logoColor=%23292F34&label=Yawiii&labelColor=%23FFFFFF&color=blue";
                        authorBadge.style.display = "block";
                        authorBadge.style.height = "20px";
                        authorTag.appendChild(authorBadge);
                        cell.appendChild(authorTag);

                        // B站徽标
                        const biliTag = document.createElement("a");
                        biliTag.href = "https://space.bilibili.com/520680644";
                        biliTag.target = "_blank";
                        biliTag.style.textDecoration = "none";
                        biliTag.style.display = "flex";
                        biliTag.style.alignItems = "center";
                        const biliBadge = document.createElement("img");
                        biliBadge.alt = "Bilibili";
                        biliBadge.src = "https://img.shields.io/badge/%E4%BD%BF%E7%94%A8%E6%95%99%E7%A8%8B-blue?style=flat&logo=bilibili&logoColor=2300A5DC&labelColor=%23FFFFFF&color=%2307A3D7";
                        biliBadge.style.display = "block";
                        biliBadge.style.height = "20px";
                        biliTag.appendChild(biliBadge);
                        cell.appendChild(biliTag);
                        // 交流群徽标
                        const wechatTag = document.createElement("a");
                        // 取消跳转；点击不再打开链接，避免本地缓存链接
                        wechatTag.href = 'javascript:void(0)';
                        wechatTag.addEventListener('click', (e) => { e.preventDefault(); toggleWechatQr(); });
                        wechatTag.style.textDecoration = "none";
                        wechatTag.style.display = "flex";
                        wechatTag.style.alignItems = "center";
                        wechatTag.classList.add("has-tooltip", "pa-wechat-badge");
                        const wechatBadge = document.createElement("img");
                        wechatBadge.alt = tUI("交流反馈群");
                        wechatBadge.src = "https://img.shields.io/badge/%E4%BA%A4%E6%B5%81%E5%8F%8D%E9%A6%88-blue?logo=wechat&logoColor=green&labelColor=%23FFFFFF&color=%2307A3D7";
                        wechatBadge.style.display = "block";
                        wechatBadge.style.height = "20px";
                        wechatTag.appendChild(wechatBadge);

                        // 悬浮显示二维码
                        const wechatQr = document.createElement("div");
                        wechatQr.className = "pa-wechat-qr";
                        const wechatQrImg = document.createElement("img");
                        // 优先加载远程二维码，失败则回退到本地备用图
                        const remoteQrUrl = 'http://data.xflow.cc/wechat.png';
                        let qrFallbackTimer = null;
                        const localQrUrl = ResourceManager.getAssetUrl('wechat.png');

                        // 每次显示时强制重新加载远程二维码（带时间戳），避免缓存
                        const loadWechatQr = () => {
                            if (qrFallbackTimer) { clearTimeout(qrFallbackTimer); qrFallbackTimer = null; }
                            wechatQrImg.dataset.fallbackApplied = '';
                            wechatQrImg.dataset.source = 'remote';
                            wechatQrImg.src = `${remoteQrUrl}?t=${Date.now()}`;
                            // 超时回退到本地，但需要判断图片是否已开始加载
                            qrFallbackTimer = setTimeout(() => {
                                // 检查是否已标记为已回退
                                if (wechatQrImg.dataset.fallbackApplied === '1') return;

                                // 检查图片是否已开始加载（naturalHeight > 0 说明图片正在加载）
                                if (wechatQrImg.naturalHeight > 0) {
                                    Logger.log(2, '远程二维码加载中，延长等待时间');
                                    // 图片已开始加载，继续等待 onload，取消超时回退
                                    if (qrFallbackTimer) { clearTimeout(qrFallbackTimer); qrFallbackTimer = null; }
                                } else {
                                    // 图片未开始加载，可能是网络问题，回退到本地
                                    Logger.log(1, '远程二维码加载超时，切换到本地备用图');
                                    loadLocalQr();
                                }
                            }, 3000); // 延长到 3 秒，给远程图片更多加载时间
                        };
                        // 手动切换到本地二维码（带时间戳），清理超时
                        const loadLocalQr = () => {
                            if (qrFallbackTimer) { clearTimeout(qrFallbackTimer); qrFallbackTimer = null; }
                            wechatQrImg.dataset.fallbackApplied = '1';
                            wechatQrImg.dataset.source = 'local';
                            wechatQrImg.src = localQrUrl; // 本地图片固定，不加时间戳
                        };

                        // 点击徽标时在远程/本地之间来回切换
                        const toggleWechatQr = () => {
                            if (wechatQrImg.dataset.source === 'local') {
                                loadWechatQr();
                            } else {
                                loadLocalQr();
                            }
                        };


                        wechatQrImg.alt = tUI("微信交流群二维码");
                        wechatQrImg.className = "pa-wechat-qr-img";

                        // 加载成功清理超时定时器
                        wechatQrImg.onload = () => { if (qrFallbackTimer) { clearTimeout(qrFallbackTimer); qrFallbackTimer = null; } };

                        // 远程加载失败时回退到本地备用图（也带时间戳避免缓存）
                        wechatQrImg.onerror = () => {
                            if (qrFallbackTimer) { clearTimeout(qrFallbackTimer); qrFallbackTimer = null; }
                            if (wechatQrImg.dataset.fallbackApplied !== '1') {
                                loadLocalQr();
                            }
                        };

                        // 初次渲染和每次鼠标进入都触发重新加载
                        loadWechatQr();
                        wechatTag.addEventListener('mouseenter', loadWechatQr);

                        wechatQr.appendChild(wechatQrImg);
                        wechatTag.appendChild(wechatQr);

                        cell.appendChild(wechatTag);

                        row.appendChild(cell);
                        return row;
                    }
                },

                // 规则配置按钮
                {
                    id: "PromptAssistant.Features.RulesConfig",
                    name: "提示词优化和反推规则修改",
                    category: ["✨提示词小助手", " 配置", "规则"],
                    tooltip: "可以自定义提示词优化规则，和反推提示词规则，使得提示词生成更加符合你的需求",
                    type: () => {
                        const row = document.createElement("tr");
                        row.className = "promptwidget-settings-row";

                        const labelCell = document.createElement("td");
                        labelCell.className = "comfy-menu-label";
                        row.appendChild(labelCell);

                        const buttonCell = document.createElement("td");
                        const button = createLoadingButton(tUI("规则管理器"), async () => {
                            showRulesConfigModal();
                        }, false);

                        buttonCell.appendChild(button);
                        row.appendChild(buttonCell);
                        return row;
                    }
                },

            ])
        });

        logger.log("小助手设置注册成功");
        return true;
    } catch (error) {
        logger.error(`小助手设置注册失败: ${error.message}`);
        return false;
    }
}
