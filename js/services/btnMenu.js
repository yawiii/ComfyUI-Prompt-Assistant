/**
 * 按钮菜单服务
 * 处理按钮右键点击弹出菜单的逻辑
 */

import { EventManager } from "../utils/eventManager.js";
import { logger } from "../utils/logger.js";
import { ResourceManager } from "../utils/resourceManager.js";
import { UIToolkit } from "../utils/UIToolkit.js";

/**
 * 按钮菜单管理类
 * 负责创建、显示和隐藏按钮右键菜单
 */
export class ButtonMenu {
    /**
     * 单例实例
     */
    static _instance = null;

    /**
     * 获取单例实例
     */
    static getInstance() {
        if (!ButtonMenu._instance) {
            ButtonMenu._instance = new ButtonMenu();
        }
        return ButtonMenu._instance;
    }

    /**
     * 构造函数
     * 初始化菜单状态和事件处理
     */
    constructor() {
        // 当前菜单DOM元素
        this.menuElement = null;

        // 当前触发菜单的按钮
        this.targetButton = null;

        // 菜单项配置
        this.menuItems = [];

        // 菜单是否显示中
        this.isMenuVisible = false;

        // 菜单上下文数据
        this.menuContext = {};

        // 初始化全局点击事件，用于关闭菜单
        this._setupGlobalEvents();

        // 日志
        logger.log("按钮菜单服务已初始化");
    }

    /**
     * 设置全局事件处理
     * 主要处理点击其他区域关闭菜单
     */
    _setupGlobalEvents() {
        // 使用事件管理器添加文档点击事件
        EventManager.addDOMListener(document, 'click', async (event) => {
            // 如果菜单可见，且点击的不是菜单内部元素，则隐藏菜单
            if (this.isMenuVisible && this.menuElement) {
                if (!this.menuElement.contains(event.target)) {
                    await this.hideMenu();
                }
            }
        });

        // 按ESC键关闭菜单
        EventManager.addDOMListener(document, 'keydown', async (event) => {
            if (event.key === 'Escape' && this.isMenuVisible) {
                await this.hideMenu();
            }
        });
    }

    /**
     * 创建菜单DOM元素
     * @param {Array} items 菜单项配置数组
     * @param {Object} context 菜单上下文数据
     * @returns {HTMLElement} 菜单DOM元素
     */
    _createMenuElement(items, context) {
        // 创建菜单容器
        const menuContainer = document.createElement('div');
        menuContainer.className = 'button-context-menu';
        // RU-FORK: меню — ребёнок body; при открытых диалогах ComfyUI (Radix)
        // body получает pointer-events:none — явное авто делает меню кликабельным
        menuContainer.style.pointerEvents = 'auto';

        // 创建菜单项列表
        const menuList = document.createElement('ul');
        menuList.className = 'button-menu-list';

        // 添加菜单项
        items.forEach(item => {
            // 如果是分隔线
            if (item.type === 'separator') {
                const separator = document.createElement('li');
                separator.className = 'button-menu-separator';
                menuList.appendChild(separator);
                return;
            }

            // 正常菜单项
            const menuItem = document.createElement('li');
            menuItem.className = 'button-menu-item';

            // 如果存在子菜单，标记样式
            const hasChildren = Array.isArray(item.children) && item.children.length > 0;
            if (hasChildren) {
                menuItem.classList.add('button-menu-item-has-children');
            }

            // 如果菜单项被禁用
            if (item.disabled) {
                menuItem.classList.add('button-menu-item-disabled');
            } else {
                // 添加点击事件（带子菜单也可点击执行自身onClick）
                menuItem.addEventListener('click', async (e) => {
                    e.preventDefault();
                    e.stopPropagation();

                    // 若点击的是右侧子菜单箭头或子菜单本身，则不触发本项点击
                    const isOnRightIcon = e.target && (e.target.classList?.contains('button-menu-right-icon') || e.target.classList?.contains('pi-chevron-right'));
                    const isInsideSubmenu = e.target && menuItem.querySelector('.button-submenu')?.contains(e.target);
                    if (isOnRightIcon || isInsideSubmenu) return;

                    // 隐藏菜单
                    await this.hideMenu();

                    // 执行回调
                    if (typeof item.onClick === 'function') {
                        item.onClick(context);
                    }
                });

                // 悬停时展示子菜单（进入时立即显示，隐藏逻辑在子菜单构建后处理，避免“穿越空隙”导致关闭）
                if (hasChildren) {
                    menuItem.addEventListener('mouseenter', () => {
                        menuItem.classList.add('submenu-open');
                    });
                    // mouseleave 的隐藏放到子菜单构建后添加带延迟的逻辑
                }
            }

            // 处理选中状态
            if (item.selected) {
                menuItem.classList.add('selected');
            }

            // 添加图标（如果有）
            if (item.icon) {
                const iconSpan = document.createElement('span');
                iconSpan.className = 'button-menu-icon';

                // 支持SVG图标
                if (typeof item.icon === 'string' && item.icon.startsWith('<svg')) {
                    iconSpan.innerHTML = item.icon;
                } else {
                    // 支持字符图标或自定义HTML
                    iconSpan.innerHTML = item.icon;
                }

                menuItem.appendChild(iconSpan);
            }

            // 添加标签
            const labelSpan = document.createElement('span');
            labelSpan.className = 'button-menu-label';
            labelSpan.textContent = item.label || '';
            menuItem.appendChild(labelSpan);

            // 如果有快捷键提示
            if (item.shortcut) {
                const shortcutSpan = document.createElement('span');
                shortcutSpan.className = 'button-menu-shortcut';
                shortcutSpan.textContent = item.shortcut;
                menuItem.appendChild(shortcutSpan);
            }

            // 如果有子菜单，添加右侧图标
            if (hasChildren) {
                const rightIcon = document.createElement('span');
                rightIcon.className = 'button-menu-right-icon pi pi-chevron-right';
                menuItem.appendChild(rightIcon);

                // 构建子菜单
                const submenu = document.createElement('div');
                submenu.className = 'button-submenu';
                const submenuList = document.createElement('ul');
                submenuList.className = 'button-menu-list';

                // —— 子菜单显示/隐藏的防抖处理，避免鼠标穿越导致关闭 ——
                let hideTimer = null;
                // 获取子菜单对齐方式，默认居中
                const submenuAlign = item.submenuAlign || 'center';
                const openSubmenu = () => {
                    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
                    menuItem.classList.add('submenu-open');
                    // 使用 requestAnimationFrame 确保子菜单已渲染再调整位置
                    requestAnimationFrame(() => {
                        this._adjustSubmenuPosition(submenu, menuItem, submenuAlign);
                    });
                };
                const scheduleCloseSubmenu = () => {
                    if (hideTimer) clearTimeout(hideTimer);
                    hideTimer = setTimeout(() => {
                        menuItem.classList.remove('submenu-open');
                        hideTimer = null;
                    }, 200);
                };

                // 父项与子菜单的鼠标事件配合，允许对角线移动
                menuItem.addEventListener('mouseleave', scheduleCloseSubmenu);
                menuItem.addEventListener('mouseenter', openSubmenu);
                submenu.addEventListener('mouseenter', openSubmenu);
                submenu.addEventListener('mouseleave', scheduleCloseSubmenu);

                item.children.forEach(subItem => {
                    if (subItem.type === 'separator') {
                        const sep = document.createElement('li');
                        sep.className = 'button-menu-separator';
                        submenuList.appendChild(sep);
                        return;
                    }

                    const subMenuItem = document.createElement('li');
                    subMenuItem.className = 'button-menu-item';

                    // 检查子菜单项是否有children(支持三级及以上菜单)
                    const hasSubChildren = Array.isArray(subItem.children) && subItem.children.length > 0;
                    if (hasSubChildren) {
                        subMenuItem.classList.add('button-menu-item-has-children');
                    }

                    if (subItem.disabled) {
                        subMenuItem.classList.add('button-menu-item-disabled');
                    } else {
                        subMenuItem.addEventListener('click', async (e) => {
                            e.preventDefault();
                            e.stopPropagation();

                            // 如果点击的是右侧箭头或子子菜单,不触发点击
                            const isOnRightIcon = e.target && (e.target.classList?.contains('button-menu-right-icon') || e.target.classList?.contains('pi-chevron-right'));
                            const isInsideSubSubmenu = e.target && subMenuItem.querySelector('.button-submenu')?.contains(e.target);
                            if (isOnRightIcon || isInsideSubSubmenu) return;

                            // 隐藏菜单
                            await this.hideMenu();

                            if (typeof subItem.onClick === 'function') {
                                subItem.onClick(context);
                            }
                        });

                        // 如果有子子菜单,添加悬停逻辑
                        if (hasSubChildren) {
                            subMenuItem.addEventListener('mouseenter', () => {
                                subMenuItem.classList.add('submenu-open');
                            });
                        }
                    }

                    if (subItem.icon) {
                        const subIcon = document.createElement('span');
                        subIcon.className = 'button-menu-icon';
                        if (typeof subItem.icon === 'string' && subItem.icon.startsWith('<svg')) {
                            subIcon.innerHTML = subItem.icon;
                        } else {
                            subIcon.innerHTML = subItem.icon;
                        }
                        subMenuItem.appendChild(subIcon);
                    }

                    const subLabel = document.createElement('span');
                    subLabel.className = 'button-menu-label';
                    subLabel.textContent = subItem.label || '';
                    subMenuItem.appendChild(subLabel);

                    if (subItem.shortcut) {
                        const subShortcut = document.createElement('span');
                        subShortcut.className = 'button-menu-shortcut';
                        subShortcut.textContent = subItem.shortcut;
                        subMenuItem.appendChild(subShortcut);
                    }

                    // 如果有子子菜单,递归创建
                    if (hasSubChildren) {
                        const subRightIcon = document.createElement('span');
                        subRightIcon.className = 'button-menu-right-icon pi pi-chevron-right';
                        subMenuItem.appendChild(subRightIcon);

                        // 构建子子菜单
                        const subSubmenu = document.createElement('div');
                        subSubmenu.className = 'button-submenu';
                        const subSubmenuList = document.createElement('ul');
                        subSubmenuList.className = 'button-menu-list';

                        // 防抖处理
                        let subHideTimer = null;
                        // 获取子菜单对齐方式，默认居中
                        const subSubmenuAlign = subItem.submenuAlign || 'center';
                        const openSubSubmenu = () => {
                            if (subHideTimer) { clearTimeout(subHideTimer); subHideTimer = null; }
                            subMenuItem.classList.add('submenu-open');
                            // 使用 requestAnimationFrame 确保子菜单已渲染再调整位置
                            requestAnimationFrame(() => {
                                this._adjustSubmenuPosition(subSubmenu, subMenuItem, subSubmenuAlign);
                            });
                        };
                        const scheduleCloseSubSubmenu = () => {
                            if (subHideTimer) clearTimeout(subHideTimer);
                            subHideTimer = setTimeout(() => {
                                subMenuItem.classList.remove('submenu-open');
                                subHideTimer = null;
                            }, 200);
                        };

                        subMenuItem.addEventListener('mouseleave', scheduleCloseSubSubmenu);
                        subMenuItem.addEventListener('mouseenter', openSubSubmenu);
                        subSubmenu.addEventListener('mouseenter', openSubSubmenu);
                        subSubmenu.addEventListener('mouseleave', scheduleCloseSubSubmenu);

                        // 渲染第三级菜单项
                        subItem.children.forEach(subSubItem => {
                            if (subSubItem.type === 'separator') {
                                const sep = document.createElement('li');
                                sep.className = 'button-menu-separator';
                                subSubmenuList.appendChild(sep);
                                return;
                            }

                            const subSubMenuItem = document.createElement('li');
                            subSubMenuItem.className = 'button-menu-item';

                            if (subSubItem.disabled) {
                                subSubMenuItem.classList.add('button-menu-item-disabled');
                            } else {
                                subSubMenuItem.addEventListener('click', async (e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    await this.hideMenu();
                                    if (typeof subSubItem.onClick === 'function') {
                                        subSubItem.onClick(context);
                                    }
                                });
                            }

                            if (subSubItem.icon) {
                                const subSubIcon = document.createElement('span');
                                subSubIcon.className = 'button-menu-icon';
                                subSubIcon.innerHTML = subSubItem.icon;
                                subSubMenuItem.appendChild(subSubIcon);
                            }

                            const subSubLabel = document.createElement('span');
                            subSubLabel.className = 'button-menu-label';
                            subSubLabel.textContent = subSubItem.label || '';
                            subSubMenuItem.appendChild(subSubLabel);

                            subSubmenuList.appendChild(subSubMenuItem);
                        });

                        subSubmenu.appendChild(subSubmenuList);
                        subMenuItem.appendChild(subSubmenu);
                    }

                    submenuList.appendChild(subMenuItem);
                });

                submenu.appendChild(submenuList);
                menuItem.appendChild(submenu);
            }

            // 添加到菜单列表
            menuList.appendChild(menuItem);
        });

        // 将菜单列表添加到容器
        menuContainer.appendChild(menuList);

        return menuContainer;
    }

    /**
     * 显示菜单
     * @param {HTMLElement} targetButton 触发菜单的按钮
     * @param {Array} items 菜单项配置
     * @param {Object} context 菜单上下文数据
     * @param {Event} event 触发事件（用于定位）
     */
    async showMenu(targetButton, items, context = {}, event) {
        // Close any open popups first
        const { PopupManager } = await import('../utils/popupManager.js');

        // 【关键】标记正在切换，防止容器折叠
        PopupManager._isTransitioning = true;


        await PopupManager.closeAllPopups();

        // 先隐藏可能已存在的菜单
        await this.hideMenu();

        // 在所有其他窗口关闭后，设置活动按钮状态
        if (context.widget && targetButton.dataset.id) {
            UIToolkit.setActiveButton({
                widget: context.widget,
                buttonId: targetButton.dataset.id
            });
            logger.debug(`右键菜单 | 设置活动按钮 | 按钮ID: ${targetButton.dataset.id}`);
        }

        // 保存参数
        this.targetButton = targetButton;
        this.menuItems = items;
        this.menuContext = context;

        // 创建菜单元素
        this.menuElement = this._createMenuElement(items, context);

        // 添加到文档
        document.body.appendChild(this.menuElement);

        // 设置菜单位置
        this._positionMenu(event);

        // 标记菜单为可见
        this.isMenuVisible = true;

        // 【关键】清除切换标记，因为菜单已经显示
        PopupManager._isTransitioning = false;


        // 阻止默认右键菜单
        if (event) {
            event.preventDefault();
            event.stopPropagation();
        }

        // 添加焦点管理
        this._setupKeyboardNavigation();
    }

    /**
     * 设置键盘导航
     */
    _setupKeyboardNavigation() {
        if (!this.menuElement) return;

        // 添加键盘事件处理
        const keyHandler = (e) => {
            if (!this.isMenuVisible) return;

            switch (e.key) {
                case 'ArrowDown':
                    this._navigateMenu(1);
                    e.preventDefault();
                    break;
                case 'ArrowUp':
                    this._navigateMenu(-1);
                    e.preventDefault();
                    break;
                case 'Enter':
                    this._activateSelectedItem();
                    e.preventDefault();
                    break;
            }
        };

        // 添加键盘事件监听
        document.addEventListener('keydown', keyHandler);

        // 保存清理函数
        this._keyboardCleanup = () => {
            document.removeEventListener('keydown', keyHandler);
        };
    }

    /**
     * 菜单导航
     * @param {number} direction 导航方向 (1: 下, -1: 上)
     */
    _navigateMenu(direction) {
        if (!this.menuElement) return;

        const items = this.menuElement.querySelectorAll('.button-menu-item:not(.button-menu-item-disabled)');
        if (items.length === 0) return;

        // 找到当前选中项
        let currentIndex = -1;
        for (let i = 0; i < items.length; i++) {
            if (items[i].classList.contains('button-menu-item-focus')) {
                currentIndex = i;
                break;
            }
        }

        // 计算下一个索引
        let nextIndex;
        if (currentIndex === -1) {
            nextIndex = direction > 0 ? 0 : items.length - 1;
        } else {
            nextIndex = (currentIndex + direction + items.length) % items.length;
        }

        // 移除所有焦点
        items.forEach(item => item.classList.remove('button-menu-item-focus'));

        // 设置新焦点
        items[nextIndex].classList.add('button-menu-item-focus');
    }

    /**
     * 激活当前选中项
     */
    _activateSelectedItem() {
        if (!this.menuElement) return;

        const focusedItem = this.menuElement.querySelector('.button-menu-item-focus');
        if (focusedItem) {
            focusedItem.click();
        }
    }

    /**
     * 隐藏菜单
     */
    async hideMenu() {
        const widget = this.menuContext?.widget;

        if (this.menuElement) {
            const menuToHide = this.menuElement; // 捕获要隐藏的菜单元素

            // 移除菜单元素
            menuToHide.classList.remove('button-menu-visible');

            // 清理键盘导航
            if (this._keyboardCleanup) {
                this._keyboardCleanup();
                this._keyboardCleanup = null;
            }

            // 使用动画完成事件监听器
            const handleTransitionEnd = () => {
                if (menuToHide && menuToHide.parentNode) {
                    menuToHide.removeEventListener('transitionend', handleTransitionEnd);
                    menuToHide.parentNode.removeChild(menuToHide);

                    // 仅当实例属性仍指向我们移除的菜单时，才将其置空
                    if (this.menuElement === menuToHide) {
                        this.menuElement = null;
                    }
                }
            };

            // 监听动画完成事件
            menuToHide.addEventListener('transitionend', handleTransitionEnd);

            // 如果动画未开始，设置超时
            setTimeout(() => {
                if (menuToHide && menuToHide.parentNode) {
                    handleTransitionEnd();
                }
            }, 300); // 300ms后强制移除，防止动画不触发
        }

        // 重置中央按钮状态
        UIToolkit.setActiveButton(null);
        // logger.debug('右键菜单 | 重置活动按钮');

        // 触发小助手可见性更新以允许其自动折叠
        if (widget) {
            try {
                // 处理提示词小助手的情况
                if (widget.type === 'prompt_assistant') {
                    const { promptAssistant } = await import('../modules/PromptAssistant.js');
                    // 先更新可见性
                    promptAssistant.updateAssistantVisibility(widget);

                    // 直接触发自动折叠（如果小助手处于展开状态）
                    if (!widget.isCollapsed) {
                        setTimeout(() => {
                            // 在下一个事件循环中触发自动折叠
                            promptAssistant.triggerAutoCollapse(widget);
                        }, 100);
                    }
                }
                // 处理图像小助手的情况 - 使用更宽松的检测条件
                else if (widget.type === 'image_caption_assistant' || widget.nodeId) {
                    const { imageCaption } = await import('../modules/imageCaption.js');
                    // 先更新可见性
                    imageCaption.updateAssistantVisibility(widget);

                    // 直接触发自动折叠（如果小助手处于展开状态）
                    if (!widget.isCollapsed) {
                        setTimeout(() => {
                            // 在下一个事件循环中触发自动折叠
                            imageCaption.triggerAutoCollapse(widget);
                        }, 100);
                    }
                }
                logger.debug(`右键菜单关闭 | 触发小助手可见性更新 | 类型: ${widget.type || '图像小助手'}`);
            } catch (error) {
                logger.error(`触发小助手可见性更新失败: ${error.message}`);
            }
        }

        // 重置状态
        this.isMenuVisible = false;
        this.targetButton = null;
        this.menuItems = [];
        this.menuContext = {};
    }

    /**
     * 定位菜单
     * @param {Event} event 触发事件
     */
    _positionMenu(event) {
        if (!this.menuElement || !this.targetButton) return;

        const buttonRect = this.targetButton.getBoundingClientRect();
        const menuRect = this.menuElement.getBoundingClientRect();

        // 计算菜单位置，使其位于按钮正上方并居中
        let x = buttonRect.left + (buttonRect.width / 2) - (menuRect.width / 2);
        let y = buttonRect.top - menuRect.height - 4; // 4px的间距

        // 设置菜单初始位置
        this.menuElement.style.left = `${x}px`;
        this.menuElement.style.top = `${y}px`;

        // 确保菜单在视口内
        setTimeout(() => this._adjustMenuPosition(), 0);
    }

    /**
     * 调整菜单位置，确保在视口内
     */
    _adjustMenuPosition() {
        if (!this.menuElement) return;

        const menuRect = this.menuElement.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const margin = 12; // 边距

        // 检查并调整水平位置
        if (menuRect.right > viewportWidth - margin) {
            const newLeft = viewportWidth - menuRect.width - margin;
            this.menuElement.style.left = `${Math.max(margin, newLeft)}px`;
        } else if (menuRect.left < margin) {
            this.menuElement.style.left = `${margin}px`;
        }

        // 检查并调整垂直位置
        if (menuRect.top < margin && this.targetButton) {
            const buttonRect = this.targetButton.getBoundingClientRect();
            let newTop = buttonRect.bottom + 4; // 4px margin

            // Check if placing it below makes it go off-screen at the bottom
            if (newTop + menuRect.height > viewportHeight - margin) {
                newTop = viewportHeight - menuRect.height - margin;
            }
            this.menuElement.style.top = `${Math.max(margin, newTop)}px`;

        } else if (menuRect.bottom > viewportHeight - margin) {
            const newTop = viewportHeight - menuRect.height - margin;
            this.menuElement.style.top = `${Math.max(margin, newTop)}px`;
        }

        // 添加显示动画
        requestAnimationFrame(() => {
            this.menuElement.classList.add('button-menu-visible');
        });
    }

    /**
     * 调整子菜单位置
     * @param {HTMLElement} submenu 子菜单元素
     * @param {HTMLElement} parentItem 父级菜单项元素
     * @param {string} align 对齐方式：'top'(上对齐), 'center'(居中), 'bottom'(下对齐)，默认 'center'
     */
    _adjustSubmenuPosition(submenu, parentItem, align = 'center') {
        if (!submenu || !parentItem) return;

        const parentRect = parentItem.getBoundingClientRect();
        const submenuRect = submenu.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const margin = 12;

        // 根据对齐方式计算初始垂直位置
        let topOffset;
        switch (align) {
            case 'top':
                // 上对齐：子菜单顶部与父项顶部对齐
                topOffset = 0;
                break;
            case 'bottom':
                // 下对齐：子菜单底部与父项底部对齐
                topOffset = parentRect.height - submenuRect.height;
                break;
            case 'center':
            default:
                // 居中：子菜单中心与父项中心对齐
                topOffset = (parentRect.height - submenuRect.height) / 2;
                break;
        }

        // 计算子菜单实际的 top 位置（基于视口）
        let actualTop = parentRect.top + topOffset;

        // 限制在视口范围内（动态调整）
        if (actualTop < margin) {
            // 超出顶部，调整到顶部边缘
            topOffset = margin - parentRect.top;
        } else if (actualTop + submenuRect.height > viewportHeight - margin) {
            // 超出底部，调整到底部边缘
            topOffset = viewportHeight - margin - submenuRect.height - parentRect.top;
        }

        // 设置垂直位置
        submenu.style.top = `${topOffset}px`;
        submenu.style.bottom = 'auto';

        // 检查水平位置：如果右侧超出视口，尝试显示在左侧
        const rightEdge = parentRect.right + submenuRect.width + 4;
        if (rightEdge > viewportWidth - margin) {
            // 显示在父菜单左侧
            submenu.style.left = 'auto';
            submenu.style.right = '100%';
            submenu.style.marginLeft = '0';
            submenu.style.marginRight = '2px';
        } else {
            // 默认显示在父菜单右侧
            submenu.style.left = '100%';
            submenu.style.right = 'auto';
            submenu.style.marginLeft = '2px';
            submenu.style.marginRight = '0';
        }
    }

    /**
     * 公开方法：设置按钮右键菜单
     * @param {HTMLElement} button 按钮元素
     * @param {Function} getMenuItems 获取菜单项的函数，接收上下文参数，返回菜单项数组或Promise
     * @param {Object} context 上下文数据
     */
    setupButtonMenu(button, getMenuItems, context = {}) {
        if (!button || typeof getMenuItems !== 'function') return;

        // 清理可能已存在的事件监听器
        if (button._menuEventCleanup) {
            button._menuEventCleanup();
        }

        // 添加右键菜单事件
        const removeContextMenu = EventManager.addDOMListener(button, 'contextmenu', async (event) => {
            event.preventDefault();
            event.stopPropagation();

            // 获取当前菜单项 - 支持异步函数
            try {
                const menuItems = await Promise.resolve(getMenuItems(context));
                if (!menuItems || menuItems.length === 0) return;

                // 显示菜单
                await this.showMenu(button, menuItems, context, event);
            } catch (error) {
                logger.error(`获取菜单项失败: ${error.message}`);
            }
        });

        // 保存清理函数
        button._menuEventCleanup = () => {
            removeContextMenu();
        };

        // 返回清理函数，方便外部调用
        return button._menuEventCleanup;
    }
}


// 创建并导出样式
export function addButtonMenuStyles() {
    // 确保资源管理器已初始化
    if (!ResourceManager.isInitialized()) {
        ResourceManager.init();
    }

    // 样式已经在popup.css中定义，不需要额外添加
    logger.debug("按钮菜单样式已从popup.css加载");
}

/**
 * 导出默认实例
 */
export const buttonMenu = ButtonMenu.getInstance();

// 自动添加样式
addButtonMenuStyles(); 