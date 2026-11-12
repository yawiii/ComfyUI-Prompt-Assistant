/**
 * 弹窗工具类
 * 提供通用的弹窗管理功能
 */

import { logger } from './logger.js';
import { UIToolkit } from "./UIToolkit.js";
import { promptAssistant } from "../modules/PromptAssistant.js";
import { ResourceManager } from './resourceManager.js';
import { rebasePromptAssistantLayers } from '../modules/uiComponents.js';

class PopupManager {
    // 保存当前活动弹窗及其信息
    static activePopup = null;
    static activePopupInfo = null;
    static eventHandlers = {
        mousedown: null,
        keydown: null,
        focus: null,
        mousemove: null,
        mouseup: null
    };





    /**
     * 显示弹窗，确保同时只有一个弹窗显示
     */
    static async showPopup(options) {
        const { popup, anchorButton, buttonInfo, onClose, preventCloseOnElementTypes = [], enableResize = false } = options;

        // Close any open context menus first
        const { buttonMenu } = await import('../services/btnMenu.js');
        buttonMenu.hideMenu();

        // 如果已有其他弹窗，先关闭它
        if (this.activePopup && this.activePopup !== popup) {
            // 【关键】标记正在切换弹窗
            this._isTransitioning = true;

            // RU-FORK BUG-FIX: раньше здесь использовались неопределённые
            // переменные oldPopup/oldPopupInfo -> ReferenceError, из-за которого
            // старый popup оставался в DOM без обработчиков, новый не
            // открывался, а _isTransitioning зависал в true навсегда.
            const oldPopup = this.activePopup;
            const oldPopupInfo = this.activePopupInfo;

            // 清除当前活动弹窗引用，避免hidePopup中的状态冲突
            this.activePopup = null;
            this.activePopupInfo = null;

            // 清理所有事件监听器
            this.cleanupAllEventListeners();

            // 关闭旧弹窗
            if (oldPopupInfo && oldPopupInfo.onClose) {
                try {
                    oldPopupInfo.onClose();
                } catch (error) {
                    logger.error(`执行关闭回调失败: ${error.message}`);
                }
            }

            // 添加关闭动画
            const isPopupUp = oldPopup.classList.contains('popup-up');
            oldPopup.classList.add(isPopupUp ? 'popup-closing-up' : 'popup-closing-down');

            // 等待动画完成后再显示新弹窗
            return new Promise(resolve => {
                setTimeout(() => {
                    if (oldPopup.parentNode) {
                        oldPopup.parentNode.removeChild(oldPopup);
                    }
                    // 显示新弹窗
                    this._showNewPopup(options);
                    // 清除切换标记
                    this._isTransitioning = false;
                    resolve();
                }, 200);
            });
        } else {
            // 没有活动弹窗，直接显示新弹窗
            return Promise.resolve(this._showNewPopup(options));
        }
    }

    /**
     * 显示新弹窗的内部方法
     */
    static _showNewPopup(options) {
        const { popup, anchorButton, buttonInfo, onClose, preventCloseOnElementTypes = [], enableResize = false } = options;

        // 在所有其他窗口关闭后，设置活动按钮状态
        if (buttonInfo) {
            UIToolkit.setActiveButton(buttonInfo);
        }

        // 保存当前弹窗信息
        this.activePopup = popup;
        this.activePopupInfo = {
            anchorButton,
            buttonInfo,
            onClose,
            preventCloseOnElementTypes
        };

        // 计算弹窗位置
        this.positionPopup(popup, anchorButton);

        // 添加到文档
        document.body.appendChild(popup);

        // RU-FORK: новый фронтенд ComfyUI блокирует body (pointer-events:none)
        // при открытых своих диалогах — явное авто возвращает кликабельность панели
        popup.style.pointerEvents = 'auto';

        // RU-FORK: согласовать слои PA с открытыми ComfyUI-диалогами
        rebasePromptAssistantLayers();

        // 设置关闭事件
        this.setupCloseEvents(popup, () => {
            this.hidePopup(popup, onClose);
        });

        // 设置拖动事件
        this.setupDragEvents(popup);

        // 如果启用窗口大小调节，在弹窗完全初始化后设置
        if (enableResize) {
            // 使用 setTimeout 确保在 DOM 完全渲染后再添加调节功能
            setTimeout(() => {
                this.setupResizeEvents(popup);
            }, 0);
        }

        // 返回弹窗元素
        return popup;
    }

    /**
     * 清理所有事件监听器
     */
    static cleanupAllEventListeners() {
        // 清理全局事件监听器
        Object.entries(this.eventHandlers).forEach(([event, handler]) => {
            if (handler) {
                try {
                    if (event === 'focus') {
                        document.removeEventListener(event, handler, true);
                    } else {
                        document.removeEventListener(event, handler);
                    }
                } catch (error) {
                    logger.error(`移除事件监听器失败: ${event}, ${error.message}`);
                }
                this.eventHandlers[event] = null;
            }
        });

        // 恢复原始的选择变化事件处理函数
        if (window.app?.canvas && this.activePopup?._originalOnSelectionChange) {
            window.app.canvas.onSelectionChange = this.activePopup._originalOnSelectionChange;
            this.activePopup._originalOnSelectionChange = null;
        }

        // 执行弹窗自身的清理函数
        if (this.activePopup && typeof this.activePopup._cleanup === 'function') {
            try {
                this.activePopup._cleanup();
            } catch (error) {
                logger.error(`执行弹窗清理函数失败: ${error.message}`);
            }
        }

        // 确保所有事件处理函数引用都被重置
        this.eventHandlers = {
            mousedown: null,
            keydown: null,
            focus: null,
            mousemove: null,
            mouseup: null
        };

        // logger.debug('弹窗管理 | 动作:清理所有事件监听器');
    }

    /**
     * 设置拖动事件
     */
    static setupDragEvents(popup) {
        const titleBar = popup.querySelector('.popup_title_bar');
        if (!titleBar) return;

        // 设置鼠标样式，表示可拖动
        titleBar.style.cursor = 'move';

        // 拖动相关变量
        let isDragging = false;
        let dragOffset = { x: 0, y: 0 };

        const handleMouseDown = (e) => {
            // 如果点击的是按钮、输入框或调节手柄，不启动拖动
            if (e.target.closest('.popup_btn') ||
                e.target.closest('.popup_action_btn') ||
                e.target.closest('.popup_resize_handle') ||
                e.target.tagName === 'INPUT' ||
                e.target.closest('input')) {
                return;
            }

            // 如果点击的是标题栏或标题文本，允许拖动
            if (e.target.closest('.popup_title') || e.target === titleBar || e.target.closest('.popup_search_container')) {
                e.preventDefault();
                isDragging = true;

                // 添加拖动状态类
                popup.classList.add('dragging');
                titleBar.classList.add('dragging');

                // 计算鼠标点击位置与弹窗左上角的偏移
                // 使用强制回流确保获取准确的位置信息
                void popup.offsetWidth; // 强制回流
                const rect = popup.getBoundingClientRect();
                dragOffset = {
                    x: e.clientX - rect.left,
                    y: e.clientY - rect.top
                };

                // 添加拖动时的样式
                popup.style.transition = 'none';
                titleBar.style.cursor = 'grabbing';

                // 添加临时的全局事件监听器
                document.addEventListener('mousemove', handleMouseMove, { passive: false });
                document.addEventListener('mouseup', handleMouseUp, { once: true });
            }
        };

        const handleMouseMove = (e) => {
            if (!isDragging) return;

            e.preventDefault();

            // 计算新位置，确保不超出视窗边界
            const newLeft = Math.max(0, Math.min(
                e.clientX - dragOffset.x,
                window.innerWidth - popup.offsetWidth
            ));
            const newTop = Math.max(0, Math.min(
                e.clientY - dragOffset.y,
                window.innerHeight - popup.offsetHeight
            ));

            // 更新弹窗位置
            popup.style.left = `${newLeft}px`;
            popup.style.top = `${newTop}px`;
        };

        const handleMouseUp = () => {
            if (!isDragging) return;

            isDragging = false;

            // 移除拖动状态类
            popup.classList.remove('dragging');
            titleBar.classList.remove('dragging');

            titleBar.style.cursor = 'move';
            popup.style.transition = ''; // 恢复过渡效果

            // 移除临时的事件监听器
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };

        // 只添加初始的mousedown事件监听
        titleBar.addEventListener('mousedown', handleMouseDown);

        // 改进清理函数的保存方式，避免覆盖
        if (!popup._cleanupFunctions) {
            popup._cleanupFunctions = [];
        }

        popup._cleanupFunctions.push(() => {
            titleBar.removeEventListener('mousedown', handleMouseDown);
            // 确保清理可能残留的事件监听器
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        });

        // 如果还没有总的清理函数，创建一个
        if (!popup._cleanup) {
            popup._cleanup = () => {
                if (popup._cleanupFunctions) {
                    popup._cleanupFunctions.forEach(cleanup => cleanup());
                    popup._cleanupFunctions = [];
                }
            };
        }
    }

    /**
     * 设置窗口大小调节事件
     */
    static setupResizeEvents(popup) {
        // ---窗口大小调节功能---
        // 检查是否已经有调节手柄，避免重复创建
        if (popup.querySelector('.popup_resize_handle')) {
            return;
        }

        // 创建右下角拖拽手柄
        const resizeHandle = document.createElement('div');
        resizeHandle.className = 'popup_resize_handle';

        // 添加调节手柄图标
        const handleIcon = ResourceManager.getIcon('icon-resize-handle.svg');
        if (handleIcon) {
            resizeHandle.appendChild(handleIcon);
        }

        popup.appendChild(resizeHandle);

        // 强制回流确保手柄正确渲染
        void resizeHandle.offsetWidth;

        // 窗口大小调节相关变量
        let isResizing = false;
        let startX, startY, startWidth, startHeight;
        const minWidth = 300; // 最小宽度
        const minHeight = 200; // 最小高度

        const handleResizeStart = (e) => {
            // 阻止事件冒泡到拖动处理器
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            isResizing = true;
            startX = e.clientX;
            startY = e.clientY;

            // 强制回流确保获取准确尺寸
            void popup.offsetWidth;
            const rect = popup.getBoundingClientRect();
            startWidth = rect.width;
            startHeight = rect.height;

            // 添加调节状态类
            popup.classList.add('resizing');

            // 禁用过渡效果
            popup.style.transition = 'none';

            // 阻止文本选择
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'nw-resize';

            // 添加临时的全局事件监听器
            document.addEventListener('mousemove', handleResizeMove, { passive: false, capture: true });
            document.addEventListener('mouseup', handleResizeEnd, { once: true, capture: true });

            logger.debug('开始调节窗口大小');
        };

        const handleResizeMove = (e) => {
            if (!isResizing) return;

            e.preventDefault();
            e.stopPropagation();

            // 计算新的尺寸
            const deltaX = e.clientX - startX;
            const deltaY = e.clientY - startY;

            let newWidth = Math.max(minWidth, startWidth + deltaX);
            let newHeight = Math.max(minHeight, startHeight + deltaY);

            // 确保不超出视窗边界
            const rect = popup.getBoundingClientRect();
            const maxWidth = window.innerWidth - rect.left - 8;
            const maxHeight = window.innerHeight - rect.top - 8;

            newWidth = Math.min(newWidth, maxWidth);
            newHeight = Math.min(newHeight, maxHeight);

            // 应用新尺寸
            popup.style.width = `${newWidth}px`;
            popup.style.height = `${newHeight}px`;
        };

        const handleResizeEnd = (e) => {
            if (!isResizing) return;

            isResizing = false;

            // 移除调节状态类
            popup.classList.remove('resizing');

            // 恢复过渡效果
            popup.style.transition = '';

            // 恢复默认样式
            document.body.style.userSelect = '';
            document.body.style.cursor = '';

            // 移除临时的事件监听器
            document.removeEventListener('mousemove', handleResizeMove, { capture: true });
            document.removeEventListener('mouseup', handleResizeEnd, { capture: true });

            // 保存标签弹窗的尺寸
            if (popup.classList.contains('tag_popup')) {
                const rect = popup.getBoundingClientRect();
                // 动态导入 TagManager 并保存尺寸
                import('../modules/tag.js').then(({ TagManager }) => {
                    TagManager.setPopupSize(rect.width, rect.height);
                }).catch(err => {
                    logger.error(`保存窗口大小失败: ${err.message}`);
                });
            }

            logger.debug('完成调节窗口大小');
        };

        // 添加初始的mousedown事件监听，使用 capture 模式确保优先处理
        resizeHandle.addEventListener('mousedown', handleResizeStart, { capture: true });

        // 添加鼠标悬停效果来提高可见性
        resizeHandle.addEventListener('mouseenter', () => {
            resizeHandle.style.opacity = '1';
        });

        resizeHandle.addEventListener('mouseleave', () => {
            if (!isResizing) {
                resizeHandle.style.opacity = '0.7';
            }
        });

        // 改进清理函数的保存方式，避免覆盖
        if (!popup._cleanupFunctions) {
            popup._cleanupFunctions = [];
        }

        popup._cleanupFunctions.push(() => {
            resizeHandle.removeEventListener('mousedown', handleResizeStart, { capture: true });
            resizeHandle.removeEventListener('mouseenter', () => { });
            resizeHandle.removeEventListener('mouseleave', () => { });
            // 确保清理可能残留的事件监听器
            document.removeEventListener('mousemove', handleResizeMove, { capture: true });
            document.removeEventListener('mouseup', handleResizeEnd, { capture: true });

            // 恢复默认样式
            document.body.style.userSelect = '';
            document.body.style.cursor = '';
        });

        // 如果还没有总的清理函数，创建一个
        if (!popup._cleanup) {
            popup._cleanup = () => {
                if (popup._cleanupFunctions) {
                    popup._cleanupFunctions.forEach(cleanup => cleanup());
                    popup._cleanupFunctions = [];
                }
            };
        }

        // logger.debug('窗口大小调节功能已启用');
    }

    /**
     * 定位弹窗
     */
    static positionPopup(popup, anchorButton) {
        try {
            const buttonRect = anchorButton.getBoundingClientRect();
            const viewportHeight = window.innerHeight;
            const viewportWidth = window.innerWidth;

            // 设置初始显示以获取尺寸
            popup.style.visibility = 'hidden';
            popup.style.display = 'flex'; // 使用flex布局
            popup.style.flexDirection = 'column';
            document.body.appendChild(popup);

            // 强制回流以确保获取准确的尺寸
            void popup.offsetWidth;
            const popupRect = popup.getBoundingClientRect();
            document.body.removeChild(popup);
            popup.style.visibility = 'visible';

            // 计算垂直位置
            const spaceAbove = buttonRect.top;
            const spaceBelow = viewportHeight - buttonRect.bottom;
            const showBelow = spaceBelow >= popupRect.height || spaceBelow > spaceAbove;

            // 设置垂直位置
            if (showBelow) {
                popup.style.top = `${buttonRect.bottom}px`;
                popup.classList.remove('popup-up');
                popup.classList.add('popup-down');
            } else {
                popup.style.top = `${buttonRect.top - popupRect.height}px`;
                popup.classList.remove('popup-down');
                popup.classList.add('popup-up');
            }

            // 计算水平位置
            const buttonCenterX = buttonRect.left + buttonRect.width / 2;
            const centeredLeftEdge = buttonCenterX - popupRect.width / 2;
            const centeredRightEdge = buttonCenterX + popupRect.width / 2;
            const canCenterHorizontally = centeredLeftEdge >= 0 && centeredRightEdge <= viewportWidth;

            if (showBelow) {
                // 下方显示时，依然居中
                if (canCenterHorizontally) {
                    popup.style.left = `${centeredLeftEdge}px`;
                } else if (centeredLeftEdge < 0) {
                    popup.style.left = '8px';
                } else {
                    popup.style.left = `${viewportWidth - popupRect.width - 8}px`;
                }
            } else {
                // 上方显示时，左对齐（弹窗左侧与按钮左侧对齐），但保证不超出右侧和左侧
                let left = buttonRect.left;
                if (left + popupRect.width > viewportWidth - 8) {
                    left = viewportWidth - popupRect.width - 8;
                }
                if (left < 8) {
                    left = 8;
                }
                popup.style.left = `${left}px`;
            }
        } catch (error) {
            logger.error(`弹窗 | 位置计算失败 | 错误:${error.message}`);
        }
    }

    /**
     * 设置关闭事件
     */
    static setupCloseEvents(popup, onClose) {
        // 清理之前的事件监听器
        this.cleanupAllEventListeners();

        // 保存原始的选择变化事件处理函数
        if (window.app?.canvas) {
            popup._originalOnSelectionChange = window.app.canvas.onSelectionChange;

            // 重写选择变化事件处理函数
            window.app.canvas.onSelectionChange = (...args) => {
                // 如果弹窗已经不存在，恢复原始处理函数
                if (!popup.isConnected) {
                    if (popup._originalOnSelectionChange) {
                        window.app.canvas.onSelectionChange = popup._originalOnSelectionChange;
                    }
                    return;
                }

                // 调用原始处理函数
                if (popup._originalOnSelectionChange) {
                    popup._originalOnSelectionChange.apply(window.app.canvas, args);
                }

                // 获取当前聚焦的元素
                const activeElement = document.activeElement;

                // 检查是否为标签相关的输入框获得焦点
                const preventCloseTypes = this.activePopupInfo?.preventCloseOnElementTypes || [];
                const isSpecialInput = activeElement &&
                    preventCloseTypes.some(type => {
                        return activeElement.classList.contains(type) ||
                            activeElement.closest(`.${type}`) !== null;
                    });

                // 检查是否为目标输入框
                const isTargetInput = activeElement && (
                    activeElement.classList.contains('comfy-multiline-input') ||
                    activeElement.closest('.comfy-multiline-input') !== null ||
                    activeElement.closest('.comfy-markdown') !== null ||
                    activeElement.closest('.widget-markdown') !== null ||
                    activeElement.closest('.tiptap') !== null ||
                    activeElement.closest('.ProseMirror') !== null
                );

                // 检查是否是当前节点的输入框
                const isCurrentNodeInput = this.activePopupInfo?.buttonInfo?.widget &&
                    Object.values(window.PromptAssistantInputWidgetMap || {}).some(mapping => {
                        return (mapping.inputEl === activeElement || mapping.inputEl?.contains(activeElement)) &&
                            mapping.widget === this.activePopupInfo.buttonInfo.widget;
                    });

                // 只有当是特殊输入框或当前节点的输入框时才阻止关闭
                if (isSpecialInput || isCurrentNodeInput || isTargetInput) {
                    logger.debug('弹窗 | 保持打开 | 原因:' + (isSpecialInput ? '特殊输入框聚焦' : (isCurrentNodeInput ? '当前节点输入框聚焦' : '目标输入框聚焦')));
                    return;
                }

                // 其他情况关闭弹窗
                if (typeof onClose === 'function') {
                    onClose();
                }
            };
        }

        // 记录鼠标点击时间，用于避免双击问题
        popup._lastClickTime = 0;

        // 点击外部关闭
        const handleOutsideClick = (e) => {
            // 如果弹窗已经不存在，移除事件监听
            if (!popup.isConnected) {
                document.removeEventListener('mousedown', handleOutsideClick);
                return;
            }

            // 防止快速连续点击导致的问题
            const now = Date.now();
            if (now - popup._lastClickTime < 200) {
                return;
            }
            popup._lastClickTime = now;

            // 检查点击目标是否在弹窗内或是触发按钮
            const isInPopup = popup.contains(e.target);
            const isInButton = e.target.closest('.prompt-assistant-button');
            const isInActiveButton = this.activePopupInfo?.anchorButton === e.target ||
                this.activePopupInfo?.anchorButton?.contains(e.target);

            // 检查是否点击的是需要阻止关闭的元素类型
            const preventCloseTypes = this.activePopupInfo?.preventCloseOnElementTypes || [];
            const isPreventCloseElement = preventCloseTypes.some(className => {
                return e.target.classList.contains(className) ||
                    e.target.closest(`.${className}`) !== null;
            });

            // 检查是否点击的是上下文菜单、确认弹窗或设置对话框
            const isContextMenu = e.target.closest('.pa-context-menu') || e.target.closest('.pa-confirm-popup');
            const isSettingsModal = e.target.closest('.settings-modal') || e.target.closest('.settings-modal-overlay');
            if (isContextMenu || isSettingsModal) return;

            // 检查是否点击的是目标输入框
            const isTargetInput = e.target.classList.contains('comfy-multiline-input') ||
                e.target.closest('.comfy-multiline-input') !== null ||
                e.target.closest('.comfy-markdown') !== null ||
                e.target.closest('.widget-markdown') !== null ||
                e.target.closest('.tiptap') !== null ||
                e.target.closest('.ProseMirror') !== null;

            // 检查是否是当前节点的输入框
            const isCurrentNodeInput = this.activePopupInfo?.buttonInfo?.widget &&
                Object.values(window.PromptAssistantInputWidgetMap || {}).some(mapping => {
                    return (mapping.inputEl === e.target || mapping.inputEl?.contains(e.target)) &&
                        mapping.widget === this.activePopupInfo.buttonInfo.widget;
                });

            // 如果点击在弹窗外且不是点击激活按钮，且不是阻止关闭的元素，且不是当前节点的输入框/目标输入框，则关闭弹窗
            if (!isInPopup && !(isInButton && isInActiveButton) &&
                !isPreventCloseElement && !isCurrentNodeInput && !isTargetInput) {
                if (typeof onClose === 'function') {
                    onClose();
                }
            }
        };

        // 添加聚焦事件监听，防止标签相关的输入框聚焦导致弹窗关闭
        const handleFocus = (e) => {
            // 如果弹窗已经不存在，移除事件监听
            if (!popup.isConnected) {
                document.removeEventListener('focus', handleFocus, true);
                return;
            }

            const preventCloseTypes = this.activePopupInfo?.preventCloseOnElementTypes || [];
            const isSpecialInput = preventCloseTypes.some(type => {
                return e.target.classList.contains(type) ||
                    e.target.closest(`.${type}`) !== null;
            });

            // 检查是否是当前节点的输入框
            const isCurrentNodeInput = this.activePopupInfo?.buttonInfo?.widget &&
                Object.values(window.PromptAssistantInputWidgetMap || {}).some(mapping => {
                    return (mapping.inputEl === e.target || mapping.inputEl?.contains(e.target)) &&
                        mapping.widget === this.activePopupInfo.buttonInfo.widget;
                });

            // 只有当是特殊输入框或当前节点的输入框获得焦点时，才阻止关闭
            if (isSpecialInput || isCurrentNodeInput) {
                e.stopPropagation();
                logger.debug('弹窗 | 阻止关闭 | 原因:' + (isSpecialInput ? '特殊输入框聚焦' : '当前节点输入框聚焦'));
            }
        };

        // ESC键关闭
        const handleEscKey = (e) => {
            // 如果弹窗已经不存在，移除事件监听
            if (!popup.isConnected) {
                document.removeEventListener('keydown', handleEscKey);
                return;
            }

            if (e.key === 'Escape') {
                // 如果存在设置对话框，不关闭标签弹窗（让设置对话框处理 ESC）
                const settingsModal = document.querySelector('.settings-modal');
                if (settingsModal) return;

                if (typeof onClose === 'function') {
                    onClose();
                }
            }
        };

        // 保存事件处理函数引用
        this.eventHandlers.mousedown = handleOutsideClick;
        this.eventHandlers.keydown = handleEscKey;
        this.eventHandlers.focus = handleFocus;

        // 确保移除可能存在的旧事件监听器
        try {
            document.removeEventListener('mousedown', this.eventHandlers.mousedown);
            document.removeEventListener('keydown', this.eventHandlers.keydown);
            document.removeEventListener('focus', this.eventHandlers.focus, true);
        } catch (error) {
            // 忽略可能的错误
        }

        // 添加事件监听
        document.addEventListener('mousedown', handleOutsideClick);
        document.addEventListener('keydown', handleEscKey);
        document.addEventListener('focus', handleFocus, true); // 使用捕获模式

        // 保存清理函数到弹窗实例
        popup._cleanup = () => {
            document.removeEventListener('mousedown', handleOutsideClick);
            document.removeEventListener('keydown', handleEscKey);
            document.removeEventListener('focus', handleFocus, true);

            // 恢复原始的选择变化事件处理函数
            if (window.app?.canvas && popup._originalOnSelectionChange) {
                window.app.canvas.onSelectionChange = popup._originalOnSelectionChange;
                popup._originalOnSelectionChange = null;
            }
        };

        // logger.debug('弹窗管理 | 动作:设置关闭事件');
    }

    /**
     * 隐藏弹窗
     */
    static hidePopup(popup, onClose) {
        if (!popup) return;

        // 如果是当前活动弹窗，则清除引用
        if (this.activePopup === popup) {
            // 保存信息用于下面的回调
            const popupInfo = this.activePopupInfo;

            // 执行弹窗自身的清理函数
            if (popup._cleanup && typeof popup._cleanup === 'function') {
                try {
                    popup._cleanup();
                    popup._cleanup = null; // 防止重复调用
                } catch (error) {
                    logger.error(`执行弹窗清理函数失败: ${error.message}`);
                }
            }

            // 清除活跃弹窗引用
            this.activePopup = null;
            this.activePopupInfo = null;

            // 清理所有事件监听器
            this.cleanupAllEventListeners();

            // 重置中央按钮状态
            if (popupInfo && popupInfo.buttonInfo) {
                const { widget, buttonId } = popupInfo.buttonInfo;
                // 无论按钮状态如何，都强制重置
                UIToolkit.setActiveButton(null);
                // 强制更新所有实例的可见性
                promptAssistant.updateAllInstancesVisibility();
                // 强制更新当前widget的状态
                if (widget) {
                    promptAssistant.updateAssistantVisibility(widget);
                }
            }

            // 即使没有buttonInfo，也尝试更新所有实例状态
            if (!popupInfo || !popupInfo.buttonInfo) {
                UIToolkit.setActiveButton(null);
                promptAssistant.updateAllInstancesVisibility();
            }

            // 执行关闭回调
            if (typeof onClose === 'function') {
                try {
                    onClose();
                } catch (error) {
                    logger.error(`执行关闭回调失败: ${error.message}`);
                }
            }
        }

        // 添加关闭动画
        const isPopupUp = popup.classList.contains('popup-up');
        popup.classList.add(isPopupUp ? 'popup-closing-up' : 'popup-closing-down');

        // 动画结束后移除元素
        return new Promise(resolve => {
            setTimeout(() => {
                if (popup.parentNode) {
                    popup.parentNode.removeChild(popup);
                }
                resolve();
            }, 200);
        });
    }

    /**
     * 关闭所有打开的弹窗
     */
    static async closeAllPopups() {
        if (this.activePopup) {
            // 保存当前活动弹窗信息
            const popupInfo = this.activePopupInfo;
            const activePopup = this.activePopup;

            // 执行弹窗自身的清理函数
            if (activePopup._cleanup && typeof activePopup._cleanup === 'function') {
                try {
                    activePopup._cleanup();
                    activePopup._cleanup = null; // 防止重复调用
                } catch (error) {
                    logger.error(`执行弹窗清理函数失败: ${error.message}`);
                }
            }

            // 清除活跃弹窗引用
            this.activePopup = null;
            this.activePopupInfo = null;

            // 清理所有事件监听器
            this.cleanupAllEventListeners();

            // 重置中央按钮状态
            if (popupInfo && popupInfo.buttonInfo) {
                const { widget, buttonId } = popupInfo.buttonInfo;
                // 无论按钮状态如何，都强制重置
                UIToolkit.setActiveButton(null);
                // 强制更新所有实例的可见性
                promptAssistant.updateAllInstancesVisibility();
                // 强制更新当前widget的状态
                if (widget) {
                    promptAssistant.updateAssistantVisibility(widget);
                }
            }

            // 即使没有buttonInfo，也尝试更新所有实例状态
            if (!popupInfo || !popupInfo.buttonInfo) {
                UIToolkit.setActiveButton(null);
                promptAssistant.updateAllInstancesVisibility();
            }

            // 执行关闭回调
            if (popupInfo && popupInfo.onClose) {
                try {
                    popupInfo.onClose();
                } catch (error) {
                    logger.error(`执行关闭回调失败: ${error.message}`);
                }
            }
        }

        // 获取所有弹窗
        const popups = document.querySelectorAll('.popup_container');
        const closePromises = [];

        // 为所有弹窗添加关闭动画
        popups.forEach(popup => {
            // 执行弹窗自身的清理函数
            if (popup._cleanup && typeof popup._cleanup === 'function') {
                try {
                    popup._cleanup();
                    popup._cleanup = null; // 防止重复调用
                } catch (error) {
                    logger.error(`执行弹窗清理函数失败: ${error.message}`);
                }
            }

            const isPopupUp = popup.classList.contains('popup-up');
            popup.classList.add(isPopupUp ? 'popup-closing-up' : 'popup-closing-down');

            // 添加到Promise数组
            closePromises.push(new Promise(resolve => {
                setTimeout(() => {
                    if (popup.parentNode) {
                        popup.parentNode.removeChild(popup);
                    }
                    resolve();
                }, 200);
            }));
        });

        // 等待所有弹窗关闭完成
        await Promise.all(closePromises);

        logger.debug('弹窗管理 | 动作:关闭所有弹窗');
    }

    /**
     * 写入内容到输入框
     */
    static writeToInput(content, nodeId, inputId) {
        return UIToolkit.writeToInput(content, nodeId, inputId, { highlight: true, focus: false });
    }

    /**
     * 在光标位置插入内容
     */
    static insertAtCursor(content, nodeId, inputId) {
        return UIToolkit.insertAtCursor(content, nodeId, inputId, { highlight: true });
    }
}

export { PopupManager };