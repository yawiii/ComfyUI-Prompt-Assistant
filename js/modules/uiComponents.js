/**
 * 通用UI组件库
 * 提供项目中可复用的UI组件
 */

import { app } from "../../../../scripts/app.js";
import { logger } from '../utils/logger.js';
import { tUI, localizeElement, observeLocalizedMutations } from "../utils/uiI18n.js";

// ---动态 Z-Index 计算---
/**
 * 获取 ComfyUI 设置弹窗的 z-index 值
 * 只针对 ComfyUI 的 p-dialog 元素进行查找，避免遍历所有 DOM 元素造成性能问题
 * @returns {number} ComfyUI 弹窗的 z-index 值，如果不存在则返回基础值
 */
function getComfyUIDialogZIndex() {
    // ComfyUI 使用 PrimeVue，设置弹窗的类名是 .p-dialog
    // 页面上可能同时存在多个对话框，取最高的那个，否则会算低而排在别的对话框之下
    let maxZIndex = 0;
    document.querySelectorAll('.p-dialog').forEach(dialog => {
        const zIndex = parseInt(window.getComputedStyle(dialog).zIndex, 10);
        if (!isNaN(zIndex) && zIndex > maxZIndex) {
            maxZIndex = zIndex;
        }
    });
    if (maxZIndex > 0) {
        return maxZIndex;
    }
    // 如果没有找到 ComfyUI 弹窗，返回 CSS 变量定义的基础值
    return 10200;
}

/**
 * 把浮层挂到 ComfyUI 当前的对话框容器内
 * 新版前端的模态层（reka-ui）会把 body 下其它元素持续标记为 pointer-events: none，
 * 浮层只有成为对话框内容的一部分才能正常接收鼠标操作；没有打开中的对话框时回落到 body
 */
function appendToModalHost(element) {
    const hosts = document.querySelectorAll('[role="dialog"]');
    const host = hosts.length ? hosts[hosts.length - 1] : document.body;
    host.appendChild(element);
}

// 插件自身的浮动窗口（标签/历史窗口、按钮菜单等），设置弹窗必须盖在它们之上
const PLUGIN_FLOATING_SELECTORS = ['.popup_container', '.pa-context-menu', '.button-submenu'];

/**
 * 获取插件浮动窗口中最高的 z-index
 * 这些窗口是 fixed 定位并直接挂在 body 上的，设置弹窗层级低于它们时会被挡住鼠标操作
 * @returns {number} 最高层级，没有浮动窗口时返回 0
 */
function getPluginFloatingMaxZIndex() {
    let maxZIndex = 0;
    PLUGIN_FLOATING_SELECTORS.forEach(selector => {
        document.querySelectorAll(selector).forEach(element => {
            const zIndex = parseInt(window.getComputedStyle(element).zIndex, 10);
            if (!isNaN(zIndex) && zIndex > maxZIndex) {
                maxZIndex = zIndex;
            }
        });
    });
    return maxZIndex;
}

/**
 * 创建通用的设置弹窗
 * @param {Object} options 弹窗配置选项
 * @param {string} options.title 弹窗标题
 * @param {Function} options.renderContent 渲染弹窗内容的函数
 * @param {Function} options.renderNotice 渲染通知区域的函数（可选，显示在标题和内容之间）
 * @param {Function} options.onSave 保存按钮点击回调
 * @param {Function} options.onCancel 取消按钮点击回调（可选）
 * @param {boolean} options.isConfirmDialog 是否是确认对话框（可选）
 * @param {string} options.saveButtonText 保存按钮文本（可选）
 * @param {string} options.cancelButtonText 取消按钮文本（可选）
 * @param {string} options.saveButtonIcon 保存按钮图标（可选）
 * @param {boolean} options.isDangerButton 保存按钮是否为危险按钮样式（可选，红色背景）
 * @param {boolean} options.disableBackdropAndCloseOnClickOutside 禁用遮罩层和点击外部关闭（可选）
 */
export function createSettingsDialog(options) {
    try {
        const {
            title,
            renderContent,
            renderNotice = null,
            onSave,
            onCancel = null,
            onClose = null,  // 关闭回调（无论保存还是取消都会调用）
            isConfirmDialog = false,
            saveButtonText = tUI('保存'),
            cancelButtonText = tUI('取消'),
            saveButtonIcon = 'pi-check',
            isDangerButton = false,  // 是否为危险按钮
            dialogClassName = null,
            disableBackdropAndCloseOnClickOutside = false,
            hideFooter = false,  // 是否隐藏底部按钮
        } = options;

        let overlay = null;
        if (!disableBackdropAndCloseOnClickOutside) {
            // 创建遮罩层
            overlay = document.createElement('div');
            overlay.className = 'settings-modal-overlay';
            appendToModalHost(overlay);
        }


        // 创建弹窗
        const modal = document.createElement('div');
        modal.className = 'settings-modal pa-settings-root';

        // 如果提供了额外的对话框类名，添加到modal
        if (dialogClassName) {
            modal.classList.add(dialogClassName);
        }

        // 如果是确认对话框，设置特殊样式
        if (isConfirmDialog) {
            // 只有在没有提供自定义类名的情况下才设置默认宽度
            if (!dialogClassName) {
                modal.style.width = 'min(90vw, 400px)';
            }
            modal.style.minHeight = 'auto';
            // z-index 由 CSS 的 .settings-modal 和 .settings-modal-overlay 统一管理，不需要在 JS 中设置
        }

        // 表单修改状态
        let isFormModified = false;

        // 内部关闭函数：关闭弹窗并调用 onClose 回调
        let stopContentLocalization = null;
        const closeDialog = () => {
            if (stopContentLocalization) {
                stopContentLocalization();
                stopContentLocalization = null;
            }
            closeModalWithAnimation(modal, overlay);
            // 在动画完成后调用 onClose 回调
            if (onClose) {
                setTimeout(() => {
                    onClose();
                }, 300); // 与动画时间匹配
            }
        };

        // 处理关闭弹窗的逻辑
        const handleCloseModal = async (saveAction) => {
            // 如果是保存操作，直接保存并关闭，不弹出确认对话框
            if (saveAction) {
                try {
                    await onSave(content);
                    closeDialog();
                } catch (error) {
                    app.extensionManager.toast.add({
                        severity: "error",
                        summary: tUI("保存失败"),
                        detail: error.message,
                        life: 3000
                    });
                }
                return;
            }

            // 只有在表单被修改、不是确认对话框、且未提供 onCancel 时才显示确认对话框
            // 如果提供了 onCancel，表示调用者选择跳过二次确认
            if (isFormModified && !isConfirmDialog && !onCancel) {
                // 创建确认对话框
                createSettingsDialog({
                    title: tUI('确认操作'),
                    isConfirmDialog: true,
                    saveButtonText: tUI('返回'),
                    saveButtonIcon: 'pi-undo',
                    cancelButtonText: tUI('关闭'),
                    renderContent: (content) => {
                        content.style.textAlign = 'center';
                        content.style.padding = '1rem';

                        const confirmMessage = document.createElement('p');
                        confirmMessage.textContent = tUI('配置已修改，是否保存？');
                        confirmMessage.style.margin = '0';
                        confirmMessage.style.fontSize = '1rem';

                        content.appendChild(confirmMessage);
                    },
                    onSave: () => {
                        // 返回按钮只关闭确认对话框，不执行保存操作
                        // 这里不需要做任何操作，因为默认的对话框关闭逻辑会在点击按钮后执行
                    },
                    onCancel: () => {
                        // 关闭主对话框
                        closeDialog();
                    }
                });
            } else {
                // 没有修改或是确认对话框或有 onCancel，直接关闭
                if (onCancel && !isConfirmDialog) {
                    onCancel();
                }
                closeDialog();
            }
        };

        if (!disableBackdropAndCloseOnClickOutside) {
            // 点击遮罩层关闭弹窗
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    handleCloseModal(false);
                }
            });
        }

        // 创建弹窗头部
        const header = document.createElement('div');
        header.className = 'p-dialog-header';

        const titleSpan = document.createElement('span');
        titleSpan.className = 'p-dialog-title';
        titleSpan.innerHTML = title;

        const closeButton = document.createElement('button');
        closeButton.className = 'p-dialog-header-icon p-dialog-header-close p-link';
        closeButton.setAttribute('aria-label', tUI('关闭'));
        closeButton.innerHTML = '<span class="pi pi-times"></span>';
        closeButton.onclick = () => {
            handleCloseModal(false);
        };

        const headerIcons = document.createElement('div');
        headerIcons.className = 'p-dialog-header-icons';
        headerIcons.appendChild(closeButton);

        header.appendChild(titleSpan);
        header.appendChild(headerIcons);

        // 创建通知区域（在标题和内容之间）
        let noticeArea = null;
        if (renderNotice) {
            noticeArea = document.createElement('div');
            noticeArea.className = 'p-dialog-notice';
            renderNotice(noticeArea);
        }

        // 创建弹窗内容
        const content = document.createElement('div');
        content.className = 'p-dialog-content';

        // 监听表单变化
        const trackFormChanges = (formElement) => {
            // 为所有输入元素添加变更监听
            const inputs = formElement.querySelectorAll('input, textarea, select');
            inputs.forEach(input => {
                const originalValue = input.type === 'checkbox' ? input.checked : input.value;

                input.addEventListener('change', () => {
                    const currentValue = input.type === 'checkbox' ? input.checked : input.value;
                    // 只有当值真正改变时才标记为已修改
                    if (currentValue !== originalValue) {
                        isFormModified = true;
                    }
                });

                if (input.tagName.toLowerCase() === 'textarea' || input.type === 'text') {
                    input.addEventListener('input', () => {
                        const currentValue = input.value;
                        // 只有当值真正改变时才标记为已修改
                        if (currentValue !== originalValue) {
                            isFormModified = true;
                        }
                    });
                }
            });

            // 监听自定义下拉框变化
            const dropdowns = formElement.querySelectorAll('.p-dropdown');
            dropdowns.forEach(dropdown => {
                // 存储原始选中值
                const hiddenSelect = dropdown.querySelector('select');
                const originalValue = hiddenSelect ? hiddenSelect.value : '';

                const observer = new MutationObserver(() => {
                    const currentValue = hiddenSelect ? hiddenSelect.value : '';
                    // 只有当值真正改变时才标记为已修改
                    if (currentValue !== originalValue) {
                        isFormModified = true;
                    }
                });
                observer.observe(dropdown, { attributes: true, childList: true, subtree: true });
            });
        };

        // 渲染内容并跟踪变化
        renderContent(content, header);
        localizeElement(header);
        if (noticeArea) {
            localizeElement(noticeArea);
        }
        localizeElement(content);
        stopContentLocalization = observeLocalizedMutations(modal);

        // 如果不是确认对话框且内容中有表单，添加变更跟踪
        if (!isConfirmDialog) {
            const forms = content.querySelectorAll('form');
            forms.forEach(trackFormChanges);

            // 如果没有找到表单，则监视整个内容区域
            if (forms.length === 0) {
                trackFormChanges(content);
            }
        }

        // 创建弹窗底部
        const footer = document.createElement('div');
        footer.className = 'p-dialog-footer';

        const cancelButton = document.createElement('button');
        cancelButton.className = 'p-button p-component p-button-secondary';
        cancelButton.innerHTML = `<span class="p-button-icon-left pi pi-times"></span><span class="p-button-label">${cancelButtonText}</span>`;

        // 为不同类型的对话框设置不同的关闭行为
        if (isConfirmDialog) {
            cancelButton.onclick = () => {
                // 对于确认对话框，"关闭"按钮应执行onCancel回调（该回调负责关闭主窗口），然后关闭自己
                if (onCancel) {
                    onCancel();
                }
                closeDialog();
            };
        } else {
            cancelButton.onclick = () => {
                // 对于普通对话框，使用标准的关闭处理逻辑
                handleCloseModal(false);
            };
        }

        const saveButton = document.createElement('button');
        // 根据isDangerButton参数设置按钮样式
        saveButton.className = isDangerButton
            ? 'p-button p-component p-button-danger'
            : 'p-button p-component';
        saveButton.innerHTML = `<span class="p-button-icon-left pi ${saveButtonIcon}"></span><span class="p-button-label">${saveButtonText}</span>`;
        saveButton.onclick = () => {
            // 如果是确认对话框中的返回按钮，直接关闭确认对话框
            if (isConfirmDialog) {
                try {
                    // 对于确认对话框，先执行onSave回调，然后关闭弹窗
                    const result = onSave && onSave(content);
                    // 如果onSave返回Promise，等待其完成
                    if (result instanceof Promise) {
                        result.then(() => {
                            closeDialog();
                        }).catch(error => {
                            logger.error(`确认对话框处理失败: ${error.message}`);
                            closeDialog();
                        });
                    } else {
                        // 普通返回值，直接关闭
                        closeDialog();
                    }
                } catch (error) {
                    logger.error(`确认对话框处理失败: ${error.message}`);
                    closeDialog();
                }
            } else {
                handleCloseModal(true);
            }
        };

        footer.appendChild(cancelButton);
        footer.appendChild(saveButton);

        // 加入拖动功能
        let isDragging = false;
        let startX = 0;
        let startY = 0;
        let offsetX = 0;
        let offsetY = 0;

        const startDragging = (e) => {
            if (e.target === closeButton || closeButton.contains(e.target)) return;

            e.preventDefault();
            isDragging = true;

            // 获取鼠标相对于弹窗的偏移量
            const rect = modal.getBoundingClientRect();
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;

            // 移除居中定位
            modal.style.transform = 'none';
            modal.style.left = rect.left + 'px';
            modal.style.top = rect.top + 'px';

            // 添加拖动状态
            modal.classList.add('dragging');

            document.addEventListener('mousemove', onDrag);
            document.addEventListener('mouseup', stopDragging);
        };

        const onDrag = (e) => {
            if (!isDragging) return;
            e.preventDefault();

            // 计算新位置（考虑鼠标在弹窗内的偏移量）
            let newLeft = e.clientX - offsetX;
            let newTop = e.clientY - offsetY;

            // 获取视口和弹窗尺寸
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            const modalRect = modal.getBoundingClientRect();
            const modalWidth = modalRect.width;
            const modalHeight = modalRect.height;

            // 边界检查（保持10px边距）
            const margin = 10;
            newLeft = Math.max(margin, Math.min(newLeft, viewportWidth - modalWidth - margin));
            newTop = Math.max(margin, Math.min(newTop, viewportHeight - modalHeight - margin));

            // 更新位置
            modal.style.left = `${newLeft}px`;
            modal.style.top = `${newTop}px`;
        };

        const stopDragging = () => {
            isDragging = false;
            modal.classList.remove('dragging');
            document.removeEventListener('mousemove', onDrag);
            document.removeEventListener('mouseup', stopDragging);
        };

        header.addEventListener('mousedown', startDragging);

        // 组装弹窗
        modal.appendChild(header);
        if (noticeArea) {
            modal.appendChild(noticeArea);
        }
        modal.appendChild(content);

        // 只有在 hideFooter 为 false 时才添加底部按钮
        if (!hideFooter) {
            modal.appendChild(footer);
        }

        // 动态计算 z-index，确保始终在 ComfyUI 弹窗和插件自身浮动窗口之上
        // 必须在 appendChild 之前设置，否则动画起始帧会使用 CSS 静态值
        const baseZIndex = Math.max(getComfyUIDialogZIndex(), getPluginFloatingMaxZIndex(), 10200) + 10;
        modal.style.zIndex = baseZIndex;
        // 弹窗内部的下拉、右键菜单等浮层都基于这个基座计算，必须同步抬高
        document.documentElement.style.setProperty('--settings-modal-z-index', String(baseZIndex));
        if (overlay) {
            overlay.style.zIndex = baseZIndex - 1;
        }

        // 显示弹窗和遮罩层
        appendToModalHost(modal);

        // 添加显示动画
        requestAnimationFrame(() => {
            modal.classList.add('modal-show');
            if (overlay) {
                overlay.classList.add('overlay-show');
            }
        });

        return modal;
    } catch (error) {
        logger.error(`创建设置弹窗失败: ${error.message}`);
        app.extensionManager.toast.add({
            severity: "error",
            summary: tUI("创建弹窗失败"),
            detail: error.message || tUI("创建设置弹窗过程中发生错误"),
            life: 3000
        });
    }
}

/**
 * 关闭弹窗时添加动画效果
 * @param {HTMLElement} modal 弹窗元素
 * @param {HTMLElement} overlay 遮罩层元素
 */
export function closeModalWithAnimation(modal, overlay) {
    // 添加关闭动画类
    modal.classList.remove('modal-show');
    modal.classList.add('modal-hide');
    if (overlay) {
        overlay.classList.remove('overlay-show');
        overlay.classList.add('overlay-hide');
    }

    // 等待动画完成后移除弹窗和遮罩层
    setTimeout(() => {
        if (modal.parentNode) {
            modal.parentNode.removeChild(modal);
        }
        if (overlay && overlay.parentNode) {
            overlay.parentNode.removeChild(overlay);
        }
    }, 300); // 与 CSS transition 时间相匹配
}

/**
 * 创建表单组
 * @param {string} title 表单组标题
 * @param {Array<{text: string, url: string}>} links 标题右侧的链接数组
 * @param {Object} [options] 额外可选项
 * @param {string} [options.prefixText] 链接前的前缀纯文本（不作为链接，不包在标签内）
 * @returns {HTMLElement} 表单组容器
 */
export function createFormGroup(title, links = [], options = {}) {
    const { prefixText = null } = options;

    const group = document.createElement('div');
    group.className = 'settings-form-section';

    const titleContainer = document.createElement('div');
    titleContainer.className = 'settings-form-section-header';
    titleContainer.style.display = 'flex';
    titleContainer.style.alignItems = 'center';
    titleContainer.style.justifyContent = 'space-between';
    titleContainer.style.marginBottom = '10px';

    const titleElem = document.createElement('h3');
    titleElem.className = 'settings-form-section-title';
    titleElem.textContent = tUI(title, title);
    titleElem.style.margin = '0';

    const linksContainer = document.createElement('div');
    linksContainer.style.display = 'flex';
    linksContainer.style.gap = '8px';
    linksContainer.style.alignItems = 'center';

    if (links.length > 0) {
        const serviceLinksContainer = document.createElement('div');
        serviceLinksContainer.className = 'settings-service-links';

        // 可选的前缀文本，保持与链接字号一致（不包在<a>标签内）
        if (prefixText) {
            const prefix = document.createElement('span');
            prefix.className = 'settings-service-prefix';
            prefix.textContent = tUI(prefixText, prefixText);
            serviceLinksContainer.appendChild(prefix);
        }

        links.forEach((linkInfo, index) => {
            if (index > 0) {
                // 添加分隔符
                const separator = document.createElement('span');
                separator.textContent = '｜';
                separator.className = 'settings-service-separator';
                serviceLinksContainer.appendChild(separator);
            }

            const link = document.createElement('a');
            link.href = linkInfo.url;
            link.target = '_blank';
            link.textContent = tUI(linkInfo.text, linkInfo.text);
            link.className = 'settings-service-link';

            serviceLinksContainer.appendChild(link);
        });

        linksContainer.appendChild(serviceLinksContainer);
    }

    titleContainer.appendChild(titleElem);
    titleContainer.appendChild(linksContainer);
    group.appendChild(titleContainer);

    return group;
}

/**
 * 创建浮动标签输入框组 (PrimeVue FloatLabel variant="on" 风格)
 * @param {string} label 标签文本
 * @param {string} placeholder 占位符文本
 * @param {string} type 输入框类型
 * @returns {Object} 包含 group 和 input 的对象
 */
export function createInputGroup(label, placeholder, type = 'text') {
    const group = document.createElement('div');
    group.className = 'settings-form-group';

    // 创建浮动标签容器
    const floatContainer = document.createElement('div');
    floatContainer.className = 'float-label-container';

    // 创建输入框
    const input = document.createElement('input');
    input.className = 'p-inputtext p-component';
    input.type = type;
    // 使用空格作为 placeholder 以触发 :not(:placeholder-shown) 选择器
    input.placeholder = ' ';

    // 创建浮动标签
    const floatLabel = document.createElement('label');
    floatLabel.textContent = tUI(label, label);

    // 组装结构: input 在前, label 在后 (使用 ~ 选择器)
    floatContainer.appendChild(input);
    floatContainer.appendChild(floatLabel);

    // 如果是数字输入框,添加自定义上下调整按钮
    if (type === 'number') {
        const buttonsContainer = document.createElement('div');
        buttonsContainer.className = 'number-input-buttons';

        // 增加按钮
        const increaseBtn = document.createElement('button');
        increaseBtn.className = 'number-input-button';
        increaseBtn.type = 'button';
        increaseBtn.innerHTML = '<i class="pi pi-chevron-up"></i>';
        increaseBtn.addEventListener('click', () => {
            const step = parseFloat(input.step) || 1;
            const max = input.max ? parseFloat(input.max) : Infinity;
            const currentValue = parseFloat(input.value) || 0;
            const newValue = Math.min(currentValue + step, max);
            input.value = newValue;
            // 触发change事件以保存数据
            input.dispatchEvent(new Event('change', { bubbles: true }));
        });

        // 减少按钮
        const decreaseBtn = document.createElement('button');
        decreaseBtn.className = 'number-input-button';
        decreaseBtn.type = 'button';
        decreaseBtn.innerHTML = '<i class="pi pi-chevron-down"></i>';
        decreaseBtn.addEventListener('click', () => {
            const step = parseFloat(input.step) || 1;
            const min = input.min ? parseFloat(input.min) : -Infinity;
            const currentValue = parseFloat(input.value) || 0;
            const newValue = Math.max(currentValue - step, min);
            input.value = newValue;
            // 触发change事件以保存数据
            input.dispatchEvent(new Event('change', { bubbles: true }));
        });

        buttonsContainer.appendChild(increaseBtn);
        buttonsContainer.appendChild(decreaseBtn);
        floatContainer.appendChild(buttonsContainer);
    }

    group.appendChild(floatContainer);

    return { group, input };
}

/**
 * 创建下拉选择框组 (PrimeVue FloatLabel variant="on" 风格)
 * @param {string} label 标签文本
 * @param {Array<{value: string, text: string}>} options 选项列表
 * @param {string} [initialValue=null] 初始选中的值
 * @param {Object} [config={}] 配置选项
 * @param {boolean} [config.showLabel=true] 是否显示浮动标签
 * @returns {Object} 包含 group 和 select 的对象
 */
export function createSelectGroup(label, options, initialValue = null, config = {}) {
    const { showLabel = true } = config;

    const group = document.createElement('div');
    group.className = 'settings-form-group';

    // 创建浮动标签容器
    const floatContainer = document.createElement('div');
    floatContainer.className = 'float-label-container';

    // Main Container
    const dropdownContainer = document.createElement('div');
    // 增加自定义样式类 pa-dropdown，保留 p-dropdown 以兼容现有逻辑（如脏检查与布局选择器）
    dropdownContainer.className = 'pa-dropdown p-dropdown p-component w-full';
    dropdownContainer.style.position = 'relative'; // Needed for panel positioning

    // Hidden select for form data and accessibility
    const select = document.createElement('select');
    const hiddenContainer = document.createElement('div');
    hiddenContainer.className = 'p-hidden-accessible';
    hiddenContainer.appendChild(select);

    // Visible Part: Label and Trigger
    const dropdownLabel = document.createElement('span');
    dropdownLabel.className = 'pa-dropdown-label p-dropdown-label p-inputtext';

    const dropdownTrigger = document.createElement('div');
    dropdownTrigger.className = 'pa-dropdown-trigger p-dropdown-trigger';
    dropdownTrigger.innerHTML = '<span class="p-dropdown-trigger-icon pi pi-chevron-down"></span>';

    // Dropdown Panel (the menu)
    const dropdownPanel = document.createElement('div');
    dropdownPanel.className = 'pa-dropdown-panel p-dropdown-panel p-component settings-modal-dropdown-panel';
    dropdownPanel.style.display = 'none'; // Initially hidden
    // z-index 由 CSS 的 --settings-dropdown-z-index 变量管理

    const dropdownItemsWrapper = document.createElement('div');
    dropdownItemsWrapper.className = 'p-dropdown-items-wrapper';

    const dropdownList = document.createElement('ul');
    dropdownList.className = 'p-dropdown-items';
    dropdownList.setAttribute('role', 'listbox');

    /**
     * 更新下拉框选项
     * @param {Array<{value: string, text: string}>} newOptions - 新选项列表
     * @param {string} [newValue=null] - 新选中的值
     */
    const updateOptions = (newOptions, newValue = null) => {
        // 清空现有选项
        select.innerHTML = '';
        dropdownList.innerHTML = '';

        if (!newOptions || newOptions.length === 0) {
            dropdownLabel.textContent = tUI('暂无选项');
            return;
        }

        // 填充新选项
        newOptions.forEach(opt => {
            const optionEl = document.createElement('option');
            optionEl.value = opt.value;
            optionEl.textContent = tUI(opt.text, opt.text);
            select.appendChild(optionEl);

            const itemEl = document.createElement('li');
            itemEl.className = 'p-dropdown-item';
            itemEl.textContent = tUI(opt.text, opt.text);
            itemEl.dataset.value = opt.value;
            itemEl.setAttribute('role', 'option');

            itemEl.addEventListener('click', (e) => {
                e.stopPropagation();
                // Update highlight
                dropdownList.querySelectorAll('.p-dropdown-item').forEach(el => el.classList.remove('p-highlight'));
                itemEl.classList.add('p-highlight');

                select.value = opt.value;
                dropdownLabel.textContent = tUI(opt.text, opt.text);
                closePanel();
                select.dispatchEvent(new Event('change', { bubbles: true }));
            });

            dropdownList.appendChild(itemEl);
        });

        // 设置选中的值
        // 如果提供了 newValue 且在选项中，则使用它；否则尝试保持当前值；最后默认首项
        const currentVal = select.value;
        const valToSet = (newValue !== null && newOptions.some(o => o.value === newValue))
            ? newValue
            : (newOptions.some(o => o.value === currentVal) ? currentVal : newOptions[0].value);

        if (valToSet !== null) {
            const selectedOption = newOptions.find(o => o.value === valToSet);
            if (selectedOption) {
                dropdownLabel.textContent = tUI(selectedOption.text, selectedOption.text);
                select.value = selectedOption.value;
                // 设置高亮
                const initialItem = dropdownList.querySelector(`.p-dropdown-item[data-value="${valToSet}"]`);
                if (initialItem) {
                    initialItem.classList.add('p-highlight');
                }
            }
        }
    };

    // 初始化渲染选项
    updateOptions(options, initialValue);

    // Assemble dropdown
    dropdownItemsWrapper.appendChild(dropdownList);
    dropdownPanel.appendChild(dropdownItemsWrapper);

    dropdownContainer.appendChild(hiddenContainer);
    dropdownContainer.appendChild(dropdownLabel);
    dropdownContainer.appendChild(dropdownTrigger);

    // 根据 showLabel 决定是否创建浮动标签
    if (showLabel) {
        // 创建浮动标签
        const floatLabel = document.createElement('label');
        floatLabel.textContent = tUI(label, label);

        // 组装浮动标签结构: dropdown 在前, label 在后
        floatContainer.appendChild(dropdownContainer);
        floatContainer.appendChild(floatLabel);
    } else {
        // 不显示浮动标签，直接添加下拉框
        floatContainer.appendChild(dropdownContainer);
    }

    group.appendChild(floatContainer);

    // --- Event Handling ---
    let isOpen = false;

    // 更新面板位置的函数
    const updatePanelPosition = () => {
        if (!isOpen) return;

        const rect = dropdownContainer.getBoundingClientRect();
        dropdownPanel.style.top = rect.bottom + 'px';
        dropdownPanel.style.left = rect.left + 'px';
        dropdownPanel.style.width = rect.width + 'px';
    };

    const closePanel = () => {
        if (!isOpen) return;
        isOpen = false;

        dropdownPanel.classList.add('p-hidden');
        dropdownPanel.classList.remove('p-enter-active');
        dropdownContainer.classList.remove('p-dropdown-open', 'p-focus');

        // 移除事件监听器
        window.removeEventListener('resize', updatePanelPosition);
        window.removeEventListener('scroll', updatePanelPosition, true);

        // 等待动画完成后再移除面板和事件监听
        setTimeout(() => {
            if (dropdownPanel.parentNode === document.body) {
                document.body.removeChild(dropdownPanel);
            }
            document.removeEventListener('click', handleOutsideClick, true);
        }, 120); // 与CSS中的transition时间相匹配
    };

    const openPanel = () => {
        isOpen = true;

        // 将面板临时附加到 body 上以避免裁切
        appendToModalHost(dropdownPanel);

        // 计算下拉框相对于视口的位置
        const rect = dropdownContainer.getBoundingClientRect();

        // 设置面板样式
        dropdownPanel.style.position = 'fixed';
        dropdownPanel.style.display = 'block';
        dropdownPanel.style.top = rect.bottom + 'px';
        dropdownPanel.style.left = rect.left + 'px';
        dropdownPanel.style.width = rect.width + 'px';
        // 动态计算 z-index，确保在 ComfyUI 弹窗之上
        dropdownPanel.style.zIndex = getComfyUIDialogZIndex() + 15;

        dropdownPanel.classList.remove('p-hidden');
        // 强制重排，确保动画生效
        dropdownPanel.offsetHeight;
        dropdownPanel.classList.add('p-enter-active');
        dropdownContainer.classList.add('p-dropdown-open', 'p-focus');

        document.addEventListener('click', handleOutsideClick, true);

        // 添加窗口大小变化和滚动事件监听器，以便重新定位面板
        window.addEventListener('resize', updatePanelPosition);
        window.addEventListener('scroll', updatePanelPosition, true);
    };

    const handleOutsideClick = (e) => {
        // 如果点击的是下拉框本身，切换状态
        if (dropdownContainer.contains(e.target)) {
            e.stopPropagation();
            if (isOpen) {
                closePanel();
            } else {
                openPanel();
            }
            return;
        }
        // 如果点击的是其他区域，关闭面板
        closePanel();
    };

    // 初始化面板状态
    dropdownPanel.classList.add('p-hidden');
    dropdownContainer.addEventListener('click', handleOutsideClick);

    select.addEventListener('change', () => {
        const selectedOption = options.find(o => o.value === select.value);
        if (selectedOption) {
            dropdownLabel.textContent = tUI(selectedOption.text, selectedOption.text);
            // Update highlight
            dropdownList.querySelectorAll('.p-dropdown-item').forEach(el => {
                if (el.dataset.value === select.value) {
                    el.classList.add('p-highlight');
                } else {
                    el.classList.remove('p-highlight');
                }
            });
        }
    });

    return { group, select, updateOptions };
}

/**
 * 创建可输入下拉框组（Combo Box）
 * 支持从下拉列表选择或自定义输入
 * @param {string} label 标签文本
 * @param {Array<{value: string, text: string}>} options 选项列表（动态传入）
 * @param {string} [initialValue=''] 初始值
 * @param {Object} [config={}] 配置选项
 * @param {string} [config.placeholder=''] 输入框占位符
 * @param {string} [config.emptyText='暂无选项'] 无选项时的提示文本
 * @param {boolean} [config.showLabel=true] 是否显示浮动标签
 * @returns {Object} 包含 group, input, setValue, getValue, updateOptions 的对象
 */
export function createComboBoxGroup(label, options = [], initialValue = '', config = {}) {
    const {
        placeholder = '',
        emptyText = tUI('暂无选项'),
        showLabel = true
    } = config;

    const group = document.createElement('div');
    group.className = 'settings-form-group';

    // 创建浮动标签容器
    const floatContainer = document.createElement('div');
    floatContainer.className = 'float-label-container';

    // ---主容器---
    const comboContainer = document.createElement('div');
    comboContainer.className = 'pa-combobox pa-dropdown p-dropdown p-component w-full';
    comboContainer.style.position = 'relative';

    // ---输入框（可见且可编辑）---
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'pa-combobox-input pa-dropdown-label p-dropdown-label p-inputtext';
    input.placeholder = placeholder || ' ';
    input.value = initialValue;

    // ---下拉触发器（箭头图标）---
    const dropdownTrigger = document.createElement('div');
    dropdownTrigger.className = 'pa-dropdown-trigger p-dropdown-trigger';
    dropdownTrigger.innerHTML = '<span class="p-dropdown-trigger-icon pi pi-chevron-down"></span>';

    // ---下拉面板---
    const dropdownPanel = document.createElement('div');
    dropdownPanel.className = 'pa-dropdown-panel pa-combobox-panel p-dropdown-panel p-component settings-modal-dropdown-panel';
    dropdownPanel.style.display = 'none';

    const dropdownItemsWrapper = document.createElement('div');
    dropdownItemsWrapper.className = 'p-dropdown-items-wrapper';

    const dropdownList = document.createElement('ul');
    dropdownList.className = 'p-dropdown-items';
    dropdownList.setAttribute('role', 'listbox');

    // ---状态变量---
    let isOpen = false;
    let currentOptions = [...options];

    // ---渲染选项列表---
    const renderOptions = (optionsList) => {
        dropdownList.innerHTML = '';

        if (optionsList.length === 0) {
            // 显示空状态提示
            const emptyItem = document.createElement('li');
            emptyItem.className = 'p-dropdown-item pa-combobox-empty';
            emptyItem.textContent = tUI(emptyText, emptyText);
            emptyItem.style.color = 'var(--p-text-muted-color)';
            emptyItem.style.fontStyle = 'italic';
            emptyItem.style.pointerEvents = 'none';
            dropdownList.appendChild(emptyItem);
            return;
        }

        optionsList.forEach(opt => {
            const itemEl = document.createElement('li');
            itemEl.className = 'p-dropdown-item';
            itemEl.textContent = tUI(opt.text, opt.text);
            itemEl.dataset.value = opt.value;
            itemEl.setAttribute('role', 'option');

            // 高亮当前选中项
            if (input.value === opt.value) {
                itemEl.classList.add('p-highlight');
            }

            itemEl.addEventListener('click', (e) => {
                e.stopPropagation();
                // 更新输入框值
                input.value = opt.value;
                // 更新高亮
                dropdownList.querySelectorAll('.p-dropdown-item').forEach(el => el.classList.remove('p-highlight'));
                itemEl.classList.add('p-highlight');
                // 关闭面板
                closePanel();
                // 触发 change 事件
                input.dispatchEvent(new Event('change', { bubbles: true }));
                input.dispatchEvent(new Event('input', { bubbles: true }));
            });

            dropdownList.appendChild(itemEl);
        });
    };

    // 初始渲染
    renderOptions(currentOptions);

    // ---组装下拉面板---
    dropdownItemsWrapper.appendChild(dropdownList);
    dropdownPanel.appendChild(dropdownItemsWrapper);

    // ---组装主容器---
    comboContainer.appendChild(input);
    comboContainer.appendChild(dropdownTrigger);

    // ---根据 showLabel 决定是否创建浮动标签---
    if (showLabel) {
        const floatLabel = document.createElement('label');
        floatLabel.textContent = tUI(label, label);
        floatContainer.appendChild(comboContainer);
        floatContainer.appendChild(floatLabel);
    } else {
        floatContainer.appendChild(comboContainer);
    }

    group.appendChild(floatContainer);

    // ---更新面板位置---
    const updatePanelPosition = () => {
        if (!isOpen) return;
        const rect = comboContainer.getBoundingClientRect();
        dropdownPanel.style.top = rect.bottom + 'px';
        dropdownPanel.style.left = rect.left + 'px';
        dropdownPanel.style.width = rect.width + 'px';
    };

    // ---关闭面板---
    const closePanel = () => {
        if (!isOpen) return;
        isOpen = false;

        dropdownPanel.classList.add('p-hidden');
        dropdownPanel.classList.remove('p-enter-active');
        comboContainer.classList.remove('p-dropdown-open', 'p-focus');

        window.removeEventListener('resize', updatePanelPosition);
        window.removeEventListener('scroll', updatePanelPosition, true);

        setTimeout(() => {
            if (dropdownPanel.parentNode === document.body) {
                document.body.removeChild(dropdownPanel);
            }
            document.removeEventListener('click', handleOutsideClick, true);
        }, 120);
    };

    // ---打开面板---
    const openPanel = () => {
        if (isOpen) return;
        isOpen = true;

        appendToModalHost(dropdownPanel);

        const rect = comboContainer.getBoundingClientRect();
        dropdownPanel.style.position = 'fixed';
        dropdownPanel.style.display = 'block';
        dropdownPanel.style.top = rect.bottom + 'px';
        dropdownPanel.style.left = rect.left + 'px';
        dropdownPanel.style.width = rect.width + 'px';
        // 动态计算 z-index，确保在 ComfyUI 弹窗之上
        dropdownPanel.style.zIndex = getComfyUIDialogZIndex() + 15;

        dropdownPanel.classList.remove('p-hidden');
        dropdownPanel.offsetHeight; // 强制重排
        dropdownPanel.classList.add('p-enter-active');
        comboContainer.classList.add('p-dropdown-open', 'p-focus');

        document.addEventListener('click', handleOutsideClick, true);
        window.addEventListener('resize', updatePanelPosition);
        window.addEventListener('scroll', updatePanelPosition, true);

        // 更新高亮状态
        dropdownList.querySelectorAll('.p-dropdown-item').forEach(el => {
            if (el.dataset.value === input.value) {
                el.classList.add('p-highlight');
            } else {
                el.classList.remove('p-highlight');
            }
        });
    };

    // ---处理外部点击---
    const handleOutsideClick = (e) => {
        // 点击面板内部不关闭
        if (dropdownPanel.contains(e.target)) {
            return;
        }
        // 点击输入框或触发器时切换状态
        if (comboContainer.contains(e.target)) {
            return; // 由输入框或触发器的事件处理
        }
        closePanel();
    };

    // ---输入框事件---
    input.addEventListener('focus', () => {
        openPanel();
        comboContainer.classList.add('p-focus');
    });

    input.addEventListener('blur', () => {
        // 延迟关闭，允许点击选项
        setTimeout(() => {
            if (!dropdownPanel.contains(document.activeElement)) {
                comboContainer.classList.remove('p-focus');
            }
        }, 150);
    });

    // ---触发器点击事件---
    dropdownTrigger.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isOpen) {
            closePanel();
        } else {
            openPanel();
            input.focus();
        }
    });

    // ---初始化面板状态---
    dropdownPanel.classList.add('p-hidden');

    // ---公开方法---
    const setValue = (value) => {
        input.value = value;
        // 更新高亮
        dropdownList.querySelectorAll('.p-dropdown-item').forEach(el => {
            if (el.dataset.value === value) {
                el.classList.add('p-highlight');
            } else {
                el.classList.remove('p-highlight');
            }
        });
    };

    const getValue = () => {
        return input.value;
    };

    const updateOptions = (newOptions) => {
        currentOptions = [...newOptions];
        renderOptions(currentOptions);
    };

    return { group, input, setValue, getValue, updateOptions };
}

/**
 * 创建水平布局的表单组
 * @param {Array<{label: string, element: HTMLElement}>} items 表单项数组
 * @returns {HTMLElement} 水平布局的表单组
 */
export function createHorizontalFormGroup(items) {
    const group = document.createElement('div');
    group.className = 'settings-form-group horizontal';

    items.forEach(item => {
        const container = document.createElement('div');

        const label = document.createElement('label');
        label.className = 'settings-form-label';
        label.textContent = tUI(item.label, item.label);

        container.appendChild(label);
        container.appendChild(item.element);

        group.appendChild(container);
    });

    return group;
}

/**
 * 创建多行文本输入框组 (PrimeVue FloatLabel variant="on" 风格)
 * @param {string} label 标签文本
 * @param {string} placeholder 占位符文本（未使用，保留参数以兼容旧代码）
 * @param {number} rows 默认行数
 * @returns {Object} 包含 group 和 textarea 的对象
 */
export function createTextareaGroup(label, placeholder, rows = 8) {
    const group = document.createElement('div');
    group.className = 'settings-form-group';

    // 创建浮动标签容器
    const floatContainer = document.createElement('div');
    floatContainer.className = 'float-label-container';

    // 创建文本域
    const textarea = document.createElement('textarea');
    textarea.className = 'p-inputtext p-component settings-form-textarea';
    // 使用空格作为 placeholder 以触发 :not(:placeholder-shown) 选择器
    textarea.placeholder = ' ';
    textarea.rows = rows;
    textarea.style.resize = 'vertical';
    textarea.style.minHeight = '150px';

    // 创建浮动标签
    const floatLabel = document.createElement('label');
    floatLabel.textContent = tUI(label, label);

    // 组装结构: textarea 在前, label 在后 (使用 ~ 选择器)
    floatContainer.appendChild(textarea);
    floatContainer.appendChild(floatLabel);

    group.appendChild(floatContainer);

    return { group, textarea };
}

/**
 * 创建开关控制组件
 * @param {string} label 标签文本
 * @param {string} description 描述文本
 * @param {boolean} defaultChecked 默认选中状态
 * @param {Function} onChange 变化回调函数
 * @returns {HTMLElement} 开关容器元素
 */
export function createSwitchControl(label, description, defaultChecked, onChange) {
    const container = document.createElement('div');
    container.className = 'switch-control-container';

    const textContainer = document.createElement('div');
    textContainer.className = 'switch-control-text';

    const labelEl = document.createElement('div');
    labelEl.className = 'switch-control-label';
    labelEl.textContent = tUI(label, label);
    textContainer.appendChild(labelEl);

    if (description) {
        const descEl = document.createElement('div');
        descEl.className = 'switch-control-desc';
        descEl.textContent = tUI(description, description);
        textContainer.appendChild(descEl);
    }

    container.appendChild(textContainer);

    // 创建开关
    const switchWrapper = document.createElement('label');
    switchWrapper.className = 'switch-wrapper';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = defaultChecked;

    const slider = document.createElement('span');
    slider.className = `switch-slider${defaultChecked ? ' checked' : ''}`;

    const sliderButton = document.createElement('span');
    sliderButton.className = `switch-button${defaultChecked ? ' checked' : ''}`;
    slider.appendChild(sliderButton);

    input.addEventListener('change', async (e) => {
        const isChecked = e.target.checked;
        if (isChecked) {
            slider.classList.add('checked');
            sliderButton.classList.add('checked');
        } else {
            slider.classList.remove('checked');
            sliderButton.classList.remove('checked');
        }
        if (onChange) {
            await onChange(isChecked);
        }
    });

    switchWrapper.appendChild(input);
    switchWrapper.appendChild(slider);
    container.appendChild(switchWrapper);

    return container;
}

/**
 * 创建加载按钮
 * @param {string} text 按钮文本
 * @param {Function} onClick 点击回调函数
 * @param {boolean} showSuccessToast 是否显示成功提示
 * @returns {HTMLElement} 按钮元素
 */
export function createLoadingButton(text, onClick, showSuccessToast = true) {
    const button = document.createElement('button');
    button.className = 'p-button p-component p-button-primary';
    button.style.width = '208px'; // 相当于w-52
    button.innerHTML = `<span class="p-button-label">${tUI(text, text)}</span>`;

    button.addEventListener('click', async () => {
        if (button.disabled) return;

        // 开始加载状态
        button.disabled = true;
        button.classList.add('p-disabled');

        try {
            await onClick();

            // 只有在 showSuccessToast 为 true 时才显示成功提示
            if (showSuccessToast) {
                app.extensionManager.toast.add({
                    severity: "success",
                    summary: tUI("清理已清理完成"),
                    life: 3000
                });
            }

        } catch (error) {
            // 显示错误提示
            app.extensionManager.toast.add({
                severity: "error",
                summary: tUI("操作失败"),
                detail: error.message || tUI("操作过程中发生错误"),
                life: 3000
            });
            logger.error(`按钮操作失败: ${error.message}`);
        } finally {
            // 恢复按钮状态
            button.disabled = false;
            button.classList.remove('p-disabled');
        }
    });

    return button;
}

/**
 * 创建确认气泡框 (参考 PrimeVue ConfirmPopup)
 * @param {Object} options 配置选项
 * @param {HTMLElement} options.target 触发元素，气泡框的指针会指向它
 * @param {string} options.message 确认消息文本
 * @param {string} [options.icon] 消息图标类名（可选，默认为 'pi-info-circle'）
 * @param {Function} options.renderFormContent 渲染表单内容的函数（可选）
 * @param {Function} options.onConfirm 确认回调函数
 * @param {Function} [options.onCancel] 取消回调函数（可选）
 * @param {string} [options.confirmLabel='确认'] 确认按钮文本
 * @param {string} [options.cancelLabel='取消'] 取消按钮文本
 * @param {string} [options.position='bottom'] 气泡相对于触发元素的位置 ('top', 'bottom', 'left', 'right')
 * @param {boolean} [options.autoPosition=true] 是否自动计算最佳弹出位置（基于元素在窗口中的位置）
 * @param {boolean} [options.singleButton=false] 是否只显示单个确认按钮（适用于信息提示场景）
 * @returns {Object} 包含 popup 元素和 close 方法的对象
 */
export function createConfirmPopup(options) {
    const {
        target,
        message,
        icon = 'pi-info-circle',
        iconColor = null,
        renderFormContent = null,
        onConfirm,
        onCancel = null,
        confirmLabel = tUI('确认'),
        cancelLabel = tUI('取消'),
        position = 'bottom',
        autoPosition = true,
        singleButton = false,
        confirmDanger = false
    } = options;

    // 创建气泡框容器
    const popup = document.createElement('div');
    popup.className = 'pa-confirm-popup';

    // 创建气泡框内容
    const content = document.createElement('div');
    content.className = 'pa-confirm-popup-content';

    // 创建消息区域
    const messageContainer = document.createElement('div');
    messageContainer.className = 'pa-confirm-popup-message';

    const iconElement = document.createElement('i');
    iconElement.className = `pi ${icon} pa-confirm-popup-icon`;
    if (iconColor) {
        iconElement.style.color = iconColor;
    }
    messageContainer.appendChild(iconElement);

    const messageText = document.createElement('span');
    messageText.textContent = tUI(message, message);
    messageContainer.appendChild(messageText);

    content.appendChild(messageContainer);

    // 如果提供了表单渲染函数，创建表单区域
    let formContainer = null;
    if (renderFormContent) {
        // 调整消息区域的下边距
        messageContainer.style.marginBottom = '12px';

        // 添加分割线
        const divider = document.createElement('div');
        divider.className = 'pa-confirm-popup-divider';
        content.appendChild(divider);

        formContainer = document.createElement('div');
        formContainer.className = 'pa-confirm-popup-form';
        renderFormContent(formContainer);
        content.appendChild(formContainer);
    }

    // 创建按钮组
    const footer = document.createElement('div');
    footer.className = 'pa-confirm-popup-footer';

    // 单按钮模式：只显示确认按钮
    if (singleButton) {
        const confirmButton = document.createElement('button');
        confirmButton.className = confirmDanger
            ? 'p-button p-component p-button-sm p-button-danger'
            : 'p-button p-component p-button-sm';
        confirmButton.innerHTML = `<span class="p-button-icon-left pi pi-check"></span><span class="p-button-label">${tUI(confirmLabel, confirmLabel)}</span>`;
        confirmButton.onclick = async () => {
            try {
                if (onConfirm) {
                    await onConfirm(formContainer);
                }
                closePopup();
            } catch (error) {
                logger.error('确认操作失败', error);
                // 如果确认操作失败，不关闭气泡框
            }
        };
        footer.appendChild(confirmButton);
    } else {
        // 双按钮模式：显示取消和确认按钮
        const cancelButton = document.createElement('button');
        cancelButton.className = 'p-button p-component p-button-secondary p-button-sm';
        cancelButton.innerHTML = `<span class="p-button-icon-left pi pi-times"></span><span class="p-button-label">${tUI(cancelLabel, cancelLabel)}</span>`;
        cancelButton.onclick = () => {
            if (onCancel) {
                onCancel();
            }
            closePopup();
        };

        const confirmButton = document.createElement('button');
        confirmButton.className = confirmDanger
            ? 'p-button p-component p-button-sm p-button-danger'
            : 'p-button p-component p-button-sm';
        confirmButton.innerHTML = `<span class="p-button-icon-left pi pi-check"></span><span class="p-button-label">${tUI(confirmLabel, confirmLabel)}</span>`;
        confirmButton.onclick = async () => {
            try {
                // 将表单容器传递给 onConfirm 回调
                await onConfirm(formContainer);
                closePopup();
            } catch (error) {
                logger.error('确认操作失败', error);
                // 如果确认操作失败，不关闭气泡框
            }
        };

        footer.appendChild(cancelButton);
        footer.appendChild(confirmButton);
    }
    content.appendChild(footer);

    // 创建指针（箭头）
    const arrow = document.createElement('div');
    arrow.className = 'pa-confirm-popup-arrow';

    popup.appendChild(arrow);
    popup.appendChild(content);

    const stopPopupLocalization = observeLocalizedMutations(popup);

    // 关闭气泡框的函数
    const closePopup = () => {
        stopPopupLocalization();
        popup.classList.add('pa-confirm-popup-hide');
        setTimeout(() => {
            if (popup.parentNode) {
                popup.parentNode.removeChild(popup);
            }
            // 移除点击外部关闭的事件监听
            document.removeEventListener('click', handleOutsideClick, true);
        }, 200);
    };

    // 点击外部关闭
    const handleOutsideClick = (e) => {
        if (!popup.contains(e.target) && !target.contains(e.target)) {
            if (onCancel) {
                onCancel();
            }
            closePopup();
        }
    };

    // ---定位气泡框---
    const positionPopup = () => {
        const targetRect = target.getBoundingClientRect();
        const popupRect = popup.getBoundingClientRect();
        const margin = 10;
        const gap = 12; // 气泡与目标之间的间隙
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        let top, left;
        let arrowPosition = '';
        let finalPosition = position;

        // 如果开启自动定位，根据目标元素位置计算最佳方向
        if (autoPosition) {
            // 计算各方向可用空间
            const spaceTop = targetRect.top - margin;
            const spaceBottom = viewportHeight - targetRect.bottom - margin;
            const spaceLeft = targetRect.left - margin;
            const spaceRight = viewportWidth - targetRect.right - margin;

            // 判断各方向是否能容纳气泡
            const canFitTop = spaceTop >= popupRect.height + gap;
            const canFitBottom = spaceBottom >= popupRect.height + gap;
            const canFitLeft = spaceLeft >= popupRect.width + gap;
            const canFitRight = spaceRight >= popupRect.width + gap;

            // 根据目标元素位置选择最佳方向
            // 优先级：用户指定的方向 > 相反方向 > 垂直/水平替代方向
            const preferHorizontal = (position === 'left' || position === 'right');

            if (preferHorizontal) {
                // 用户偏好水平方向
                if (position === 'left' && canFitLeft) {
                    finalPosition = 'left';
                } else if (position === 'right' && canFitRight) {
                    finalPosition = 'right';
                } else if (canFitRight) {
                    finalPosition = 'right';
                } else if (canFitLeft) {
                    finalPosition = 'left';
                } else if (canFitBottom) {
                    finalPosition = 'bottom';
                } else if (canFitTop) {
                    finalPosition = 'top';
                } else {
                    // 空间都不够，选择垂直空间最大的方向
                    finalPosition = spaceBottom >= spaceTop ? 'bottom' : 'top';
                }
            } else {
                // 用户偏好垂直方向（默认）
                if (position === 'bottom' && canFitBottom) {
                    finalPosition = 'bottom';
                } else if (position === 'top' && canFitTop) {
                    finalPosition = 'top';
                } else if (canFitBottom) {
                    finalPosition = 'bottom';
                } else if (canFitTop) {
                    finalPosition = 'top';
                } else if (canFitRight) {
                    finalPosition = 'right';
                } else if (canFitLeft) {
                    finalPosition = 'left';
                } else {
                    // 空间都不够，选择垂直空间最大的方向
                    finalPosition = spaceBottom >= spaceTop ? 'bottom' : 'top';
                }
            }
        }

        // 根据最终方向计算位置
        switch (finalPosition) {
            case 'top':
                top = targetRect.top - popupRect.height - gap;
                left = targetRect.left + (targetRect.width / 2) - (popupRect.width / 2);
                arrowPosition = 'bottom';
                break;
            case 'left':
                top = targetRect.top + (targetRect.height / 2) - (popupRect.height / 2);
                left = targetRect.left - popupRect.width - gap;
                arrowPosition = 'right';
                break;
            case 'right':
                top = targetRect.top + (targetRect.height / 2) - (popupRect.height / 2);
                left = targetRect.right + gap;
                arrowPosition = 'left';
                break;
            case 'bottom':
            default:
                top = targetRect.bottom + gap;
                left = targetRect.left + (targetRect.width / 2) - (popupRect.width / 2);
                arrowPosition = 'top';
                break;
        }

        // 水平边界检查（确保气泡不超出视口）
        if (left < margin) {
            left = margin;
        } else if (left + popupRect.width > viewportWidth - margin) {
            left = viewportWidth - popupRect.width - margin;
        }

        // 垂直边界检查
        if (top < margin) {
            top = margin;
        } else if (top + popupRect.height > viewportHeight - margin) {
            top = viewportHeight - popupRect.height - margin;
        }

        popup.style.top = `${top}px`;
        popup.style.left = `${left}px`;

        // 设置箭头位置
        arrow.className = `pa-confirm-popup-arrow ${arrowPosition}`;

        // 计算箭头的偏移，使其指向触发元素的中心
        if (arrowPosition === 'top' || arrowPosition === 'bottom') {
            let arrowLeft = targetRect.left + (targetRect.width / 2) - left;
            // 确保箭头不超出气泡边界
            arrowLeft = Math.max(16, Math.min(arrowLeft, popupRect.width - 16));
            arrow.style.left = `${arrowLeft}px`;
            arrow.style.top = '';
        } else if (arrowPosition === 'left' || arrowPosition === 'right') {
            let arrowTop = targetRect.top + (targetRect.height / 2) - top;
            // 确保箭头不超出气泡边界
            arrowTop = Math.max(16, Math.min(arrowTop, popupRect.height - 16));
            arrow.style.top = `${arrowTop}px`;
            arrow.style.left = '';
        }
    };

    // 将气泡框添加到 body
    appendToModalHost(popup);
    localizeElement(popup);

    // 定位气泡框
    requestAnimationFrame(() => {
        positionPopup();
        popup.classList.add('pa-confirm-popup-show');

        // 延迟添加外部点击监听，防止立即触发
        setTimeout(() => {
            document.addEventListener('click', handleOutsideClick, true);
        }, 100);
    });

    return {
        popup,
        close: closePopup
    };
}

/**
 * 创建右键菜单组件 (参考 PrimeVue Menu)
 * @param {Object} options 配置选项
 * @param {HTMLElement} options.target 触发元素，右键菜单会在此元素上触发
 * @param {Array<Object>} options.items 菜单项列表
 * @param {string} options.items[].label 菜单项文本
 * @param {string} [options.items[].icon] 菜单项图标类名（可选）
 * @param {Function} options.items[].onClick 菜单项点击回调
 * @param {boolean} [options.items[].separator] 是否为分隔符（可选）
 * @param {boolean} [options.items[].disabled] 是否禁用（可选）
 * @returns {Object} 包含 destroy 方法的对象
 */
/**
 * 显示右键菜单 (动态显示，不需要绑定特定元素)
 * @param {Object} options 配置选项
 * @param {number} options.x 显示位置 X 坐标
 * @param {number} options.y 显示位置 Y 坐标
 * @param {Array<Object>} options.items 菜单项列表
 * @param {Function} [options.onClose] 菜单关闭回调
 */
export function showContextMenu(options) {
    const {
        x,
        y,
        items = [],
        onClose
    } = options;

    // 移除现有的右键菜单（但不移除 Split Button 的菜单和下拉菜单）
    const existingMenu = document.querySelector('.pa-context-menu:not(.pa-split-button-menu):not(.pa-dropdown-menu)');
    if (existingMenu) {
        existingMenu.remove();
    }

    const menu = document.createElement('div');
    menu.className = 'pa-context-menu pa-context-menu-show'; // 直接显示

    // 我们需要手动设置样式以确保它立即可见但可以被定位
    menu.style.display = 'block';

    const menuList = document.createElement('ul');
    menuList.className = 'pa-context-menu-list';

    const closeMenu = () => {
        menu.classList.remove('pa-context-menu-show');
        menu.classList.add('pa-context-menu-hide');

        setTimeout(() => {
            if (menu && menu.parentNode) {
                menu.parentNode.removeChild(menu);
            }
        }, 150);

        document.removeEventListener('click', handleOutsideClick, true);
        document.removeEventListener('contextmenu', handleOutsideClick, true);

        if (onClose) {
            onClose();
        }
    };

    items.forEach(item => {
        if (item.separator) {
            const separator = document.createElement('li');
            separator.className = 'pa-context-menu-separator';
            menuList.appendChild(separator);
        } else {
            const menuItem = document.createElement('li');
            menuItem.className = 'pa-context-menu-item';

            if (item.disabled) {
                menuItem.classList.add('disabled');
            }

            if (item.danger) {
                menuItem.classList.add('danger');
            }

            const menuItemContent = document.createElement('div');
            menuItemContent.className = 'pa-context-menu-item-content';

            if (item.icon) {
                const icon = document.createElement('i');
                icon.className = `pi ${item.icon} pa-context-menu-item-icon`;
                menuItemContent.appendChild(icon);
            }

            const label = document.createElement('span');
            label.className = 'pa-context-menu-item-label';
            label.textContent = tUI(item.label, item.label);
            menuItemContent.appendChild(label);

            menuItem.appendChild(menuItemContent);

            if (!item.disabled && item.onClick) {
                menuItem.addEventListener('click', (e) => {
                    e.stopPropagation();
                    item.onClick(e);
                    closeMenu();
                });
            }

            menuList.appendChild(menuItem);
        }
    });

    menu.appendChild(menuList);
    appendToModalHost(menu);

    // 定位菜单
    const menuRect = menu.getBoundingClientRect();
    let left = x;
    let top = y;

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    if (left + menuRect.width > viewportWidth) {
        left = viewportWidth - menuRect.width - 10;
    }

    if (top + menuRect.height > viewportHeight) {
        top = viewportHeight - menuRect.height - 10;
    }

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    // 点击外部关闭
    const handleOutsideClick = (e) => {
        if (menu && !menu.contains(e.target)) {
            closeMenu();
        }
    };

    // 延迟添加外部点击监听
    setTimeout(() => {
        document.addEventListener('click', handleOutsideClick, true);
        document.addEventListener('contextmenu', handleOutsideClick, true);
    }, 100);

    return {
        close: closeMenu
    };
}

/**
 * 创建右键菜单组件 (参考 PrimeVue Menu)
 * @param {Object} options 配置选项
 * @param {HTMLElement} options.target 触发元素,右键菜单会在此元素上触发
 * @param {Array<Object>|Function} options.items 菜单项列表或返回菜单项列表的函数
 * @returns {Object} 包含 destroy 方法的对象
 */
export function createContextMenu(options) {
    const {
        target,
        items = []
    } = options;

    const handleContextMenu = (e) => {
        e.preventDefault();
        e.stopPropagation();

        // 如果 items 是函数,则调用它获取最新的菜单项列表
        const menuItems = typeof items === 'function' ? items() : items;

        showContextMenu({
            x: e.clientX,
            y: e.clientY,
            items: menuItems
        });
    };

    target.addEventListener('contextmenu', handleContextMenu);

    const destroy = () => {
        target.removeEventListener('contextmenu', handleContextMenu);
    };

    return {
        destroy
    };
}

/**
 * 创建 Tooltip 提示框 (参考 PrimeVue Tooltip)
 * @param {Object} options 配置选项
 * @param {HTMLElement} options.target 触发元素
 * @param {string} options.content 提示内容
 * @param {string} [options.position='top'] 提示框位置 ('top', 'bottom', 'left', 'right')
 * @returns {Object} 包含 destroy 方法的对象
 */
export function createTooltip(options) {
    const {
        target,
        content,
        position = 'top'
    } = options;

    let tooltip = null;
    let showTimeout = null;
    let hideTimeout = null;

    // 创建 tooltip 元素
    const createTooltipElement = () => {
        tooltip = document.createElement('div');
        tooltip.className = 'pa-tooltip';
        tooltip.textContent = tUI(content, content);

        // 创建箭头
        const arrow = document.createElement('div');
        arrow.className = 'pa-tooltip-arrow';
        tooltip.appendChild(arrow);

        appendToModalHost(tooltip);
    };

    // 定位 tooltip
    const positionTooltip = () => {
        if (!tooltip) return;

        const targetRect = target.getBoundingClientRect();
        const tooltipRect = tooltip.getBoundingClientRect();

        let top, left;
        let arrowClass = '';

        switch (position) {
            case 'top':
                top = targetRect.top - tooltipRect.height - 8;
                left = targetRect.left + (targetRect.width / 2) - (tooltipRect.width / 2);
                arrowClass = 'bottom';
                break;
            case 'bottom':
                top = targetRect.bottom + 8;
                left = targetRect.left + (targetRect.width / 2) - (tooltipRect.width / 2);
                arrowClass = 'top';
                break;
            case 'left':
                top = targetRect.top + (targetRect.height / 2) - (tooltipRect.height / 2);
                left = targetRect.left - tooltipRect.width - 8;
                arrowClass = 'right';
                break;
            case 'right':
                top = targetRect.top + (targetRect.height / 2) - (tooltipRect.height / 2);
                left = targetRect.right + 8;
                arrowClass = 'left';
                break;
        }

        // 边界检查
        const margin = 10;
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        if (left < margin) {
            left = margin;
        } else if (left + tooltipRect.width > viewportWidth - margin) {
            left = viewportWidth - tooltipRect.width - margin;
        }

        if (top < margin) {
            top = margin;
        } else if (top + tooltipRect.height > viewportHeight - margin) {
            top = viewportHeight - tooltipRect.height - margin;
        }

        tooltip.style.top = `${top}px`;
        tooltip.style.left = `${left}px`;

        const arrow = tooltip.querySelector('.pa-tooltip-arrow');
        if (arrow) {
            arrow.className = `pa-tooltip-arrow ${arrowClass}`;
        }
    };

    // 显示 tooltip
    const showTooltip = () => {
        clearTimeout(hideTimeout);
        showTimeout = setTimeout(() => {
            if (!tooltip) {
                createTooltipElement();
            }
            positionTooltip();
            requestAnimationFrame(() => {
                tooltip.classList.add('pa-tooltip-show');
            });
        }, 200); // 延迟 200ms 显示
    };

    // 隐藏 tooltip
    const hideTooltip = () => {
        clearTimeout(showTimeout);
        if (tooltip) {
            tooltip.classList.remove('pa-tooltip-show');
            hideTimeout = setTimeout(() => {
                if (tooltip && tooltip.parentNode) {
                    tooltip.parentNode.removeChild(tooltip);
                    tooltip = null;
                }
            }, 150);
        }
    };

    // 绑定事件
    target.addEventListener('mouseenter', showTooltip);
    target.addEventListener('mouseleave', hideTooltip);

    // 销毁方法
    const destroy = () => {
        clearTimeout(showTimeout);
        clearTimeout(hideTimeout);
        target.removeEventListener('mouseenter', showTooltip);
        target.removeEventListener('mouseleave', hideTooltip);
        if (tooltip && tooltip.parentNode) {
            tooltip.parentNode.removeChild(tooltip);
        }
        tooltip = null;
    };

    return {
        destroy
    };
}

/**
 * 创建多选 Listbox 组件
 * @param {Object} options 配置选项
 * @param {HTMLElement} options.triggerElement 触发元素（按钮），用于定位
 * @param {string} options.placeholder 搜索框占位符
 * @param {Function} options.fetchItems 异步获取数据的函数，返回 Promise<Array>
 * @param {Function} options.onConfirm 确认选择回调，参数为选中项数组
 * @param {Function} options.onCancel 取消回调（可选）
 * @returns {void}
 */
export function createMultiSelectListbox(options) {
    const {
        triggerElement,
        placeholder = tUI('搜索...'),
        fetchItems,
        onConfirm,
        onCancel = null
    } = options;

    // 获取触发按钮的位置
    const btnRect = triggerElement.getBoundingClientRect();

    // 创建listbox容器
    const listbox = document.createElement('div');
    listbox.className = 'pa-multi-listbox';

    // 创建搜索框容器
    const searchContainer = document.createElement('div');
    searchContainer.className = 'pa-multi-listbox-search';

    const searchWrapper = document.createElement('div');
    searchWrapper.className = 'pa-multi-listbox-search-wrapper';

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = tUI(placeholder, placeholder);
    searchInput.className = 'pa-multi-listbox-search-input';

    const searchIcon = document.createElement('i');
    searchIcon.className = 'pi pi-search pa-multi-listbox-search-icon';

    searchWrapper.appendChild(searchInput);
    searchWrapper.appendChild(searchIcon);
    searchContainer.appendChild(searchWrapper);
    listbox.appendChild(searchContainer);

    // 创建列表容器
    const listContainer = document.createElement('div');
    listContainer.className = 'pa-multi-listbox-content';
    listbox.appendChild(listContainer);

    // 创建底部操作栏
    const footer = document.createElement('div');
    footer.className = 'pa-multi-listbox-footer';

    const countLabel = document.createElement('span');
    countLabel.className = 'pa-multi-listbox-count';
    countLabel.textContent = tUI('已选 0 项');

    const actions = document.createElement('div');
    actions.className = 'pa-multi-listbox-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'p-button p-component p-button-secondary p-button-sm';
    cancelBtn.innerHTML = `<span class="p-button-icon-left pi pi-times"></span><span class="p-button-label">${tUI('取消')}</span>`;

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'p-button p-component p-button-sm';
    confirmBtn.innerHTML = `<span class="p-button-icon-left pi pi-check"></span><span class="p-button-label">${tUI('确定')}</span>`;
    confirmBtn.disabled = true;

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);

    footer.appendChild(countLabel);
    footer.appendChild(actions);
    listbox.appendChild(footer);

    // 数据存储
    let allItems = [];
    let selectedItems = new Set();

    // 显示loading状态
    const showLoading = () => {
        listContainer.innerHTML = `
            <div class="loading-container">
                <div class="loading-spinner"></div>
                <div class="loading-text">${tUI('加载中...')}</div>
            </div>
        `;
    };

    // 显示错误信息
    const showError = (message) => {
        listContainer.innerHTML = `
            <div style="text-align: center; padding: 40px 20px;">
                <div style="font-size: 48px; margin-bottom: 16px;">⚠️</div>
                <div style="font-size: 14px; color: var(--p-text-color); margin-bottom: 8px;">${tUI('加载失败')}</div>
                <div style="font-size: 13px; color: var(--p-red-500);">${message}</div>
                <div style="font-size: 12px; color: var(--p-text-muted-color); margin-top: 12px;">${tUI('你仍然可以在搜索框中手动输入模型名称')}</div>
            </div>
        `;
        // 不禁用搜索框,允许用户手动输入模型名称
    };

    // 更新选中计数
    const updateCount = () => {
        countLabel.textContent = `${tUI('已选')} ${selectedItems.size} ${tUI('项')}`;
        // 如果有选中项或搜索框有内容,则启用确认按钮
        const hasInput = searchInput.value.trim().length > 0;
        confirmBtn.disabled = selectedItems.size === 0 && !hasInput;
    };

    // 渲染列表
    const renderList = (searchTerm = '') => {
        listContainer.innerHTML = '';

        const filteredItems = searchTerm
            ? allItems.filter(item => item.toLowerCase().includes(searchTerm.toLowerCase()))
            : allItems;

        if (filteredItems.length === 0) {
            const emptyHint = document.createElement('div');
            emptyHint.className = 'pa-multi-listbox-empty';
            emptyHint.textContent = searchTerm ? tUI('未找到匹配项') : tUI('暂无可用项');
            listContainer.appendChild(emptyHint);
            return;
        }

        filteredItems.forEach(itemName => {
            const item = document.createElement('div');
            item.className = 'pa-multi-listbox-item';
            if (selectedItems.has(itemName)) {
                item.classList.add('selected');
            }

            const checkbox = document.createElement('div');
            checkbox.className = 'pa-multi-listbox-checkbox';

            const label = document.createElement('span');
            label.textContent = itemName;

            item.appendChild(checkbox);
            item.appendChild(label);

            // 点击切换选中状态
            item.addEventListener('click', () => {
                if (selectedItems.has(itemName)) {
                    selectedItems.delete(itemName);
                    item.classList.remove('selected');
                } else {
                    selectedItems.add(itemName);
                    item.classList.add('selected');
                }
                updateCount();
            });

            listContainer.appendChild(item);
        });
    };

    // 初始化数据
    const initialize = async () => {
        showLoading();
        try {
            const items = await fetchItems();
            if (!items || !Array.isArray(items)) {
                throw new Error(tUI('数据格式错误'));
            }
            allItems = items;
            renderList();
        } catch (error) {
            showError(error.message || tUI('未知错误'));
        }
    };

    // 搜索框事件
    searchInput.addEventListener('input', (e) => {
        renderList(e.target.value);
        updateCount(); // 输入时更新按钮状态
    });

    // 取消按钮
    cancelBtn.addEventListener('click', () => {
        if (onCancel) {
            onCancel();
        }
        close();
    });

    // 确定按钮
    confirmBtn.addEventListener('click', () => {
        const selected = Array.from(selectedItems);
        const searchValue = searchInput.value; // 获取搜索框的值
        onConfirm(selected, searchValue); // 将搜索框的值作为第二个参数传递
        close();
    });

    // 创建透明背景层
    const overlay = document.createElement('div');
    overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        z-index: var(--settings-multi-listbox-z-index);
    `;

    overlay.appendChild(listbox);
    appendToModalHost(overlay);
    localizeElement(listbox);
    const stopListboxLocalization = observeLocalizedMutations(listbox);

    // 计算并设置位置（右对齐按钮，自适应上下）
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const listboxHeight = 400; // max-height
    const spaceBelow = viewportHeight - btnRect.bottom;
    const spaceAbove = btnRect.top;

    if (spaceBelow >= listboxHeight || spaceBelow > spaceAbove) {
        // 显示在按钮下方
        listbox.style.top = `${btnRect.bottom + 4}px`;
    } else {
        // 显示在按钮上方
        listbox.style.bottom = `${viewportHeight - btnRect.top + 4}px`;
    }

    // 右对齐按钮
    listbox.style.right = `${viewportWidth - btnRect.right}px`;

    // 关闭函数
    const close = () => {
        stopListboxLocalization();
        if (overlay.parentNode) {
            document.body.removeChild(overlay);
        }
    };

    // 点击背景关闭
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            if (onCancel) {
                onCancel();
            }
            close();
        }
    });

    // 初始化数据
    initialize();

    // 聚焦搜索框
    setTimeout(() => searchInput.focus(), 100);
}

/**
 * 创建 SplitButton 组件 (参考 PrimeVue SplitButton)
 * @param {Object} options 配置选项
 * @param {string} options.label 按钮文本
 * @param {string} options.icon 按钮图标
 * @param {string} options.className 自定义类名
 * @param {Function} options.onClick 主按钮点击回调
 * @param {Array} options.items 下拉菜单项 [{label, icon, command, separator, checked, disabled}]
 * @returns {Object} { container, updateLabel, updateIcon, updateMenu, setMainButtonDisabled, setMenuButtonDisabled }
 */
export function createSplitButton(options) {
    const { label = '', icon = '', className = '', onClick = () => { }, items = [], align = 'left' } = options;

    const container = document.createElement('div');
    container.className = `p-splitbutton p-component${className ? ' ' + className : ''}`;
    container.style.display = 'inline-flex';
    container.style.position = 'relative';

    // 1. 主按钮
    const mainKey = document.createElement('button');
    mainKey.className = 'p-button p-component p-button-text p-button-sm';
    mainKey.type = 'button';
    mainKey.style.borderTopRightRadius = '0';
    mainKey.style.borderBottomRightRadius = '0';
    mainKey.style.borderRight = '0 none';

    // 内容容器
    const mainContent = document.createElement('span');
    mainContent.className = 'p-button-label p-c';
    mainContent.style.display = 'flex';
    mainContent.style.alignItems = 'center';
    mainContent.style.gap = '0.5rem';

    const renderMainButton = (text, iconClass, spinning = false) => {
        mainContent.innerHTML = '';
        if (iconClass) {
            const i = document.createElement('span');
            i.className = `p-button-icon p-button-icon-left ${iconClass} ${spinning ? 'spinning' : ''}`;
            mainContent.appendChild(i);
        }
        const span = document.createElement('span');
        span.className = 'p-button-label';
        span.textContent = tUI(text, text);
        mainContent.appendChild(span);

        // 更新 stored data for subsequent updates via updateIcon
        mainKey.dataset.label = text;
        mainKey.dataset.icon = iconClass || '';
    };

    renderMainButton(label, icon);
    mainKey.appendChild(mainContent);
    mainKey.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick(e);
    });

    // 2. 下拉触发按钮
    const menuBtn = document.createElement('button');
    menuBtn.className = 'p-button p-component p-button-icon-only p-button-text p-button-sm p-splitbutton-menubutton';
    menuBtn.type = 'button';
    menuBtn.style.borderTopLeftRadius = '0';
    menuBtn.style.borderBottomLeftRadius = '0';
    menuBtn.innerHTML = '<span class="p-button-icon pi pi-chevron-down"></span>';

    container.appendChild(mainKey);
    container.appendChild(menuBtn);

    // 3. 下拉菜单
    const menuPanel = document.createElement('div');
    menuPanel.className = 'pa-context-menu pa-split-button-menu';
    menuPanel.style.display = 'none';
    menuPanel.style.position = 'fixed';
    menuPanel.style.minWidth = '12rem';
    // z-index 由 CSS 的 --settings-context-menu-z-index 变量管理

    const menuList = document.createElement('ul');
    menuList.className = 'pa-context-menu-list';
    menuList.setAttribute('role', 'menu');
    menuPanel.appendChild(menuList);
    appendToModalHost(menuPanel);

    let currentItems = items;
    let isOpen = false;
    let submenuPanels = []; // 存储所有子菜单面板，用于关闭时清理

    // 创建单个菜单项（支持二级子菜单）
    const createMenuItem = (item, parentPanel) => {
        if (item.separator) {
            const sep = document.createElement('li');
            sep.className = 'pa-context-menu-separator';
            sep.setAttribute('role', 'separator');
            return sep;
        }

        const li = document.createElement('li');
        li.className = 'pa-context-menu-item';
        li.setAttribute('role', 'menuitem');
        if (item.disabled) li.classList.add('disabled');

        const itemContent = document.createElement('div');
        itemContent.className = 'pa-context-menu-item-content';

        // Icon logic
        let iconHtml = '';
        if (typeof item.checked === 'boolean') {
            const checkIcon = item.checked ? 'pi pi-check' : '';
            iconHtml = `<span class="pa-context-menu-item-icon ${checkIcon}"></span>`;
        } else if (item.icon) {
            iconHtml = `<span class="pa-context-menu-item-icon ${item.icon}"></span>`;
        } else {
            iconHtml = '<span class="pa-context-menu-item-icon"></span>';
        }

        // 检查是否有子菜单
        const hasSubmenu = item.items && item.items.length > 0;

        itemContent.innerHTML = `
            ${iconHtml}
            <span class="pa-context-menu-item-label">${tUI(item.label, item.label)}</span>
            ${hasSubmenu ? '<span class="pa-context-menu-submenu-icon pi pi-chevron-right"></span>' : ''}
        `;

        li.appendChild(itemContent);

        // 如果有子菜单
        if (hasSubmenu) {
            li.classList.add('pa-context-menu-item-has-submenu');

            // 创建子菜单面板
            const submenuPanel = document.createElement('div');
            submenuPanel.className = 'pa-context-menu pa-context-submenu';
            submenuPanel.style.display = 'none';
            submenuPanel.style.position = 'fixed';

            const submenuList = document.createElement('ul');
            submenuList.className = 'pa-context-menu-list';
            submenuList.setAttribute('role', 'menu');

            item.items.forEach(subItem => {
                const subLi = createMenuItem(subItem, submenuPanel);
                submenuList.appendChild(subLi);
            });

            submenuPanel.appendChild(submenuList);
            appendToModalHost(submenuPanel);

            // 将子菜单面板添加到列表中，用于关闭时清理
            submenuPanels.push(submenuPanel);

            let submenuTimeout = null;

            // 显示子菜单
            const showSubmenu = () => {
                clearTimeout(submenuTimeout);
                submenuPanel.style.display = 'block';
                submenuPanel.style.zIndex = parseInt(menuPanel.style.zIndex || getComfyUIDialogZIndex()) + 5;
                submenuPanel.classList.add('pa-context-menu-show');

                // 定位子菜单
                const liRect = li.getBoundingClientRect();
                const submenuRect = submenuPanel.getBoundingClientRect();
                const viewportWidth = window.innerWidth;
                const viewportHeight = window.innerHeight;

                let left = liRect.right + 2;
                let top = liRect.top;

                // 如果右边空间不够，显示在左边
                if (left + submenuRect.width > viewportWidth - 10) {
                    left = liRect.left - submenuRect.width - 2;
                }

                // 垂直边界检查
                if (top + submenuRect.height > viewportHeight - 10) {
                    top = viewportHeight - submenuRect.height - 10;
                }
                if (top < 10) top = 10;

                submenuPanel.style.left = `${left}px`;
                submenuPanel.style.top = `${top}px`;
            };

            // 隐藏子菜单
            const hideSubmenu = () => {
                submenuTimeout = setTimeout(() => {
                    submenuPanel.classList.remove('pa-context-menu-show');
                    submenuPanel.classList.add('pa-context-menu-hide');
                    setTimeout(() => {
                        submenuPanel.style.display = 'none';
                        submenuPanel.classList.remove('pa-context-menu-hide');
                    }, 150);
                }, 100);
            };

            // 鼠标进入父项显示子菜单
            li.addEventListener('mouseenter', showSubmenu);
            li.addEventListener('mouseleave', hideSubmenu);

            // 保持子菜单打开（当鼠标在子菜单上时）
            submenuPanel.addEventListener('mouseenter', () => {
                clearTimeout(submenuTimeout);
            });
            submenuPanel.addEventListener('mouseleave', hideSubmenu);

        } else if (!item.disabled) {
            // 无子菜单且未禁用，绑定点击事件
            li.addEventListener('click', (e) => {
                e.stopPropagation();
                if (item.command) {
                    item.command({ originalEvent: e, item });
                }
                closeMenu();
            });
        }

        return li;
    };

    const renderMenu = () => {
        // 先清理之前的子菜单面板
        submenuPanels.forEach(panel => {
            if (panel.parentNode) {
                panel.parentNode.removeChild(panel);
            }
        });
        submenuPanels = [];

        menuList.innerHTML = '';
        currentItems.forEach(item => {
            const li = createMenuItem(item, menuPanel);
            menuList.appendChild(li);
        });
    };

    const updatePosition = () => {
        if (!isOpen) return;
        const containerRect = container.getBoundingClientRect();

        // 先确保面板是显示的以便获取宽度
        menuPanel.style.display = 'block';
        const panelRect = menuPanel.getBoundingClientRect();

        let left = containerRect.left;
        let top = containerRect.bottom + 2;

        if (align === 'right') {
            left = containerRect.right - panelRect.width;
        }

        // 边界检查：防止溢出屏幕右侧
        if (left + panelRect.width > window.innerWidth) {
            left = window.innerWidth - panelRect.width - 5;
        }
        // 边界检查：防止溢出屏幕左侧
        if (left < 0) left = 5;

        menuPanel.style.top = `${top}px`;
        menuPanel.style.left = `${left}px`;
    };

    const closeMenu = () => {
        if (!isOpen) return;
        isOpen = false;

        // 清理所有子菜单面板
        submenuPanels.forEach(panel => {
            if (panel.parentNode) {
                panel.parentNode.removeChild(panel);
            }
        });
        submenuPanels = [];

        menuPanel.classList.remove('pa-context-menu-show');
        menuPanel.classList.add('pa-context-menu-hide');

        setTimeout(() => {
            menuPanel.style.display = 'none';
            menuPanel.classList.remove('pa-context-menu-hide');
        }, 150);

        window.removeEventListener('resize', updatePosition);
        window.removeEventListener('scroll', updatePosition, true);
        document.removeEventListener('click', outsideClickListener);
    };

    const openMenu = () => {
        if (isOpen) {
            closeMenu();
            return;
        }
        isOpen = true;

        // 支持动态获取菜单项 (如果 items 是函数)
        if (typeof options.items === 'function') {
            currentItems = options.items();
        }

        renderMenu(); // Render fresh on open to catch state changes
        menuPanel.style.display = 'block';
        // 动态计算 z-index，确保在 ComfyUI 弹窗之上
        menuPanel.style.zIndex = getComfyUIDialogZIndex() + 20;
        menuPanel.classList.add('pa-context-menu-show');
        updatePosition();

        window.addEventListener('resize', updatePosition);
        window.addEventListener('scroll', updatePosition, true);
        setTimeout(() => document.addEventListener('click', outsideClickListener), 0);
    };

    const outsideClickListener = (e) => {
        if (!menuPanel.contains(e.target) && !menuBtn.contains(e.target) && !container.contains(e.target)) {
            closeMenu();
        }
    };

    menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openMenu();
    });

    return {
        container,
        updateLabel: (text) => renderMainButton(text, mainKey.dataset.icon),
        updateIcon: (newIcon, spinning) => renderMainButton(mainKey.dataset.label, newIcon, spinning),
        updateMainButton: (text, newIcon, spinning) => renderMainButton(text, newIcon, spinning),
        updateMenu: (newItems) => {
            currentItems = newItems;
            if (isOpen) renderMenu();
        },
        setMainButtonDisabled: (disabled) => { mainKey.disabled = disabled; },
        setMenuButtonDisabled: (disabled) => { menuBtn.disabled = disabled; },
        destroy: () => {
            // Cleanup if needed
            if (menuPanel && menuPanel.parentNode) menuPanel.parentNode.removeChild(menuPanel);
            // Remove listeners... (handled by closure mostly, but good practice if needed)
        }
    };
}

/**
 * 创建 SelectButton 组件 (参考 PrimeVue SelectButton)
 * 支持单选、多选、切换三种模式
 * @param {string} label 标签文本
 * @param {Array<Object>} options 选项数组，每个选项包含 { value: string, label: string, icon?: string, disabled?: boolean }
 * @param {string|Array<string>} initialValue 初始值，单选为字符串，多选为数组
 * @param {Object} config 配置选项
 * @param {string} config.mode 模式：'single'(单选), 'multiple'(多选), 'toggle'(切换，相当于开关)
 * @param {string} config.size 尺寸：'small', 'normal', 'large'
 * @param {boolean} config.allowEmpty 是否允许全部不选（仅多选模式有效）
 * @param {Function} config.onChange 值变化回调函数
 * @returns {Object} { group: HTMLElement, getValue: Function, setValue: Function }
 */
export function createSelectButtonGroup(label, options, initialValue, config = {}) {
    const {
        mode = 'multiple',
        size = 'normal',
        allowEmpty = true,
        onChange = null
    } = config;

    // ---创建容器---
    const group = document.createElement('div');
    group.className = 'pa-form-group pa-select-button-group';

    // 标签
    if (label) {
        const labelEl = document.createElement('label');
        labelEl.className = 'pa-form-label';
        labelEl.textContent = tUI(label, label);
        group.appendChild(labelEl);
    }

    // 按钮容器
    const buttonContainer = document.createElement('div');
    buttonContainer.className = `pa-select-button pa-select-button-${size}`;

    // 当前选中值
    let currentValue = mode === 'multiple'
        ? (Array.isArray(initialValue) ? [...initialValue] : [])
        : initialValue;

    // 渲染选项按钮
    const renderButtons = () => {
        buttonContainer.innerHTML = '';

        options.forEach((option, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'pa-select-button-item';

            // 判断是否选中
            const isSelected = mode === 'multiple'
                ? currentValue.includes(option.value)
                : currentValue === option.value;

            if (isSelected) {
                button.classList.add('pa-select-button-item-selected');
            }

            if (option.disabled) {
                button.classList.add('pa-select-button-item-disabled');
                button.disabled = true;
            }

            // 图标
            if (option.icon) {
                const icon = document.createElement('span');
                icon.className = `pa-select-button-icon pi ${option.icon}`;
                button.appendChild(icon);
            }

            // 标签
            if (option.label) {
                const labelSpan = document.createElement('span');
                labelSpan.className = 'pa-select-button-label';
                labelSpan.textContent = tUI(option.label, option.label);
                button.appendChild(labelSpan);
            }

            // 点击事件
            if (!option.disabled) {
                button.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleClick(option.value);
                });
            }

            buttonContainer.appendChild(button);
        });
    };

    // 处理点击事件
    const handleClick = (value) => {
        const prevValue = mode === 'multiple' ? [...currentValue] : currentValue;

        if (mode === 'multiple') {
            // 多选模式：切换选中状态
            const index = currentValue.indexOf(value);
            if (index === -1) {
                currentValue.push(value);
            } else {
                // 检查是否允许取消选择
                if (allowEmpty || currentValue.length > 1) {
                    currentValue.splice(index, 1);
                }
            }
        } else if (mode === 'toggle') {
            // 切换模式：点击切换开关状态
            currentValue = currentValue === value ? null : value;
        } else {
            // 单选模式：直接选中
            currentValue = value;
        }

        // 重新渲染按钮
        renderButtons();

        // 触发回调
        if (onChange) {
            onChange(currentValue, prevValue);
        }
    };

    // 初始渲染
    renderButtons();
    group.appendChild(buttonContainer);

    // ---返回组件API---
    return {
        group,
        getValue: () => mode === 'multiple' ? [...currentValue] : currentValue,
        setValue: (newValue) => {
            currentValue = mode === 'multiple'
                ? (Array.isArray(newValue) ? [...newValue] : [])
                : newValue;
            renderButtons();
        },
        setOptions: (newOptions) => {
            options = newOptions;
            renderButtons();
        }
    };
}
