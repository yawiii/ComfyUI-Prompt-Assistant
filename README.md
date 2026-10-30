
<div align="center">

<h1 align="center">ComfyUI Prompt Assistant✨提示词小助手V2.0</h1>


<img alt="GitHub Repo stars" src="https://img.shields.io/github/stars/idleeyan/ComfyUI-Prompt-Assistant">
<a href="https://space.bilibili.com/520680644"><img alt="bilibili" src="https://img.shields.io/badge/详细视频教程-blue?style=flat&logo=bilibili&logoColor=2300A5DC&labelColor=%23FFFFFF&color=%2307A3D7"></a>
<a href="https://data.xflow.cc/wechat.png"><img alt="weChat" src="https://img.shields.io/badge/欢迎加入交流群-blue?logo=wechat&logoColor=green&labelColor=%23FFFFFF&color=%2307A3D7"></a>
<a href="https://ycn58r88iss5.feishu.cn/share/base/form/shrcnJ1AzbUJCynW9qrNJ2zPugy"><img alt="bug" src="https://img.shields.io/badge/Bug-反馈-orange"></a>

</div>

<div align="center">

[简体中文](README.md) | [English](README.en.md)

</div>

<h4 align="center">🎉🎉全新版本的提示词小助手上线啦！功能更强，响应速度更快！适配ComfyUI node2.0！🎉🎉</h4>

> 支持调用云端大模型API、本地Ollama大模型。实现提示词、Markdown节点、节点文档翻译；提示词优化、图像反推和视频反推；常用标签收藏、历史记录等功能。是一个全能all in one的提示词插件！


## **📣更新**

<details open>
<summary><strong>[2026-10-30] 🔧Fork 修复</strong></summary>

**Fixes:**
* **规则管理器显示异常**：修复新版 ComfyUI 前端（comfyui-frontend-package 1.5x+）下规则管理器弹窗透明无边框、无法点击的问题。补全前端不再注入的 `--p-*` 主题变量；弹窗与内部浮层改为跟随基座的响应式尺寸与层级；浮层统一挂载到当前打开的对话框容器内，避免被模态层标记 `pointer-events: none` 而无法点击。

</details>

<details>
<summary><strong>[2026-04-21] 🔥V2.0.6</strong></summary>

**Changes:**
* **V3 架构升级**：全面重构节点底层逻辑，适配 ComfyUI V3 API 标准，大幅提升响应速度与运行稳定性。

**Fixes:**
* **视频反推报错修复**：修复由于部分模型（如 Qwen3.5-Plus）被误判为不支持多图分析而导致的报错问题。现在支持根据模型名智能推断推上限并进行自动截断，不再弹出报错中断任务。
* **Ollama 请求优化与修复**：优化 Ollama 请求逻辑，支持智能路由（`base_url` 不加 `/v1` 走原生 API，加 `/v1` 走 OpenAI 兼容 API），同时修复流式过滤逻辑导致部分模型返回空内容引发崩溃的报错问题。
* **子图挂载优化**：修复子图（Subgraph）节点在 Node 2.0 (Vue) 和 LiteGraph 模式下无法创建小助手或挂载不稳定的问题，支持子图中多个同名输入框的精确匹配。

</details>

<details>
<summary><strong>V2.0.5</strong></summary>

**Changes:**

* **节点随机种子**：为所有节点添加了统一的随机种子实现节点重复执行，移除通过触发词“[R]”机制实现可重复执行的机制；
  
  
* **前端UI新增多语言支持**：感谢@rafek1241
添加了 ui-i18n 功能，目前支持（中、英、日、韩、法、西、俄、德等）；

**Fixes:**
* **节点宽度被锁死**：修复 node2.0 下导致节点无法修改宽度问题。

* **置灰内置服务商 baseUrl输入框**：避免误修改导致请求出现移除。

* **网络异常报错**：修复因为强制直连机制，导致 xflow 等中转站请求出现网络异常报错。
* **图像节点✨图标移至右侧**:避免node2.0 下与节点 id 信息重叠。

</details>
<details>
<summary><strong>V2.0.4</strong></summary>


* **bug修复**：修复标签和历史功能无法使用的问题；

</details>
<details>
<summary><strong>V2.0.3</strong></summary>


* **小助手UI**：修复子图节小助手创建不稳定的情况，图像节点丢失图像的情况下无法创建小助手的情况；
  
* **Ollama**：修复因为代理原因导致HTTP502错误

</details>
<details>
<summary><strong>V2.0.2</strong></summary>

* **标签模块**：修复格式问题，现在可以在自由新建分类和管理标签了。修复预设创建和迁移出错问题；
  
* **小助手UI**：优化node2.0下的挂载方法，修复子图无法创建小助手和某些情况下不稳定的问题，并提升性能；
  
* **交互优化**：请求过程新增流式输入效果、优化交互细节；
  
* **翻译模块**：新增混合语言翻译规则参数，可以设置默认翻译成中文\英文、完善了节点文档翻译；

* **内置规则**：修复部分规则，出现中英混合、kontext输出没有翻译等问题；
  
* **API请求**：修复gemimi-3-pro无法请求的问题；修复ollama404问题；
  
* **节点优化**：完善视频反推节点；
  
* **控制台日志**：优化日志输出，修复进度日志无限输出的bug；
 
* **依赖更新**：避免缺少依赖无法启动问题；

</details>
<details>
<summary><strong>V2.0.0</strong></summary>

* **调用优化**：全面重构小助手，提升API、Ollama调用和稳定度、响应速度；
  
* **UI优化**：重构前端小助手组件，更加稳定，支持**node2.0**模式，可以自定义显示位置、拖动按钮排序；
  
* **标签模块优化**：全新标签机制。改为加载csv模式，支持多到csv随时切换、支持标签收藏；
* **规则模块优化**：全新配置窗口、支持分类、定义规则显示的位置；加入多个预置规则；
* **API服务模块优化**：全新**api**配置界面。支持自定义服务、支持添加多个模型作为备选；扩写、翻译、反推可独立选择服务
* **节点重构**：重构所有节点，支持多语言，添加视频反推节点（**beta**）；
* **用户配置文件迁移**：迁移到 `\user\default\prompt-assistant` 避免重装时用户数据丢失；
* **新增功能**：节点文档翻译、markdown节点翻译

</details>

<details>
<summary><strong>V1.x.x</strong></summary>

<details>
<summary><strong>V1.2.x </strong></summary>

<details>

<summary>[2025-11-12]  V1.2.3 </summary>

* 修复ollama和自定义服务时，返回为空的问题；
* Ollama改用原生接口，更好支持qwen3vl；
* 新增http api作为保底，避免出现请求异常;

</details>

<details>

<summary>[2025-10-14]  V1.2.2 </summary>

* 移除兼容代码，不再支持comfyUI0.3.27以下的版本。避免小助手UI出现问题；
* 修复扩写、翻译使用302.ai服务时报错问题，ollama无法自动释放问题；
* 所有节点添加独立的ollama释放选项；
* 移除llm和vlm的强制直连参数，避免偶发请求报错问题，在设置界面中添加是否直连选项；
* 优化控制台日志输出格式，显示更加清晰直观；

</details>

<details>

<summary>[2025-10-14]V1.2.1 </summary>

* 优化小助手UI的反应灵敏度；
* 增强api请求重试机制；
* 设置界面新增翻译标点符号、自动移除多余空格、移除多余连续点号、保留换行符等选项；
* 标签窗口记忆窗口大小，记忆上次选中的分类，以及标签栏滚动；
* API配置界面，新增自动获取模型列表功能；
* Ollama新增自动释放显存选项；
* 修复预览任意节点在列表情况无法为每个文本框创建小助手的bug。

</details>

<details>

<summary>[2025-9-16]V1.2.0 </summary>

* 新增提示词扩写节点
* 新增302.AI、Ollama服务
* 标签面板新增记忆功能
* 右键菜单支持快速切换服务
* 针对某些主流模型支持关闭思维链
* 优化反推和翻译节点
* 新增交流反馈入口徽标
* 修复下拉菜单bug
* 修复标签面板搜索标签无法插入bug
* 修复base\_url裁剪错误，解决偶发性请求报错

</details>
</details>

<details>

<summary><strong>V1.1.x </strong></summary>

<details>

<summary>[2025-8-28]V1.1.3 </summary>

* 优化小助手UI，实现自动避开滚动条，避免重叠误触
* 修复标签弹窗无滚动条，内容显示不全的问题

</details>

<details>

<summary>[2025-8-23]V1.1.2 </summary>

* 重构节点，解决执行时产生多队列和重复执行的问题
* API配置界面添加模型参数，某些报错可以尝试调整最大token数解决
* 简化图像反推流程，提升反推速度
* 修复了标签按需加载时，无法搜索到未加载的标签

</details>

<details>

<summary>[2025-8-10]V1.1.1 </summary>

-修复图像反推节点报错

</details>

<details>

<summary>[2025-8-10]V1.1.0 </summary>

* 修改了UI交互
* 支持所有兼容OpenAI SDK API
* 新增自定自定义规则
* 新增自定义标签
* 新增图像反推、Kontext预设、翻译节点节点

</details>

</details>

<details>

<summary><strong>V1.0.x</strong> </summary>

<details>

<summary>[2025-6-24]V1.0.6： </summary>

* 修复了一些界面bug

</details>

<details>

<summary>[2025-6-24]V1.0.5： </summary>

* 修复新版创建使用选择工具栏创建kontext节点时，出现小助手UI异常问题
* 修复可能网络环境问题造成的智谱无法服务无法使用问题
* 修复可能出现实例清除出错导致工作流无法加载问题
* 修复AIGODLIKE-COMFYUI-TRANSLATION汉化插件导致标签弹窗打开卡住的问题
* 新增标签面板可以调整大小
* 优化UI资源加载机制

</details>

<details>

<summary>[2025-6-24]V1.0.3： </summary>

* 重构了api请求服务，避免apikey暴露在前端
* 修改了配置的保存和读取机制，解决配置无法保存问题
* 修复了少许bug

</details>

<details>

<summary>[2025-6-21]V1.0.2：</summary>

* 修复了少许bug

</details>

<details>

<summary>[2025-6-15]V1.0.0:</summary>

* 一键插入tag
* 支持llm扩写
* 支持百度翻译和llm翻译切换
* 图片反推提示词
* 历史、撤销、重做

</details>

</details>

</details>

## **✨ 功能介绍**
#### 💡提示词优化+翻译

`支持预设多套提示词优化规则（如扩写、qwen-edit指令优化，kontext指令优化并翻译等`

`无语设置目标语言，自动中英互译，自带翻译缓存功能，避免重复翻译导致原文偏差`

![翻译扩写](https://github.com/user-attachments/assets/a37b715e-ecfd-47d6-a4b8-a0b1e6bb9fcd) 


#### 🖼图像反推

`在图像节点上快速实现将图片反推成提示词，支持（中/英），支持多种反推风格（如自然语言、Tag风格...）`

![反推](https://github.com/user-attachments/assets/3713ddc5-4e2e-4412-88ee-077d86f21b99)


#### 🔖标签、短语预设与收藏

`可将常用标签、短语、Lora触发词收集，快速插入。标签可收藏、自定义、排序、并且支持多套标签切换。`

![标签功能](https://github.com/user-attachments/assets/944173be-8167-42eb-93d9-e0c05256ccf8)


#### 🕐历史、撤销、重做

`可以按句为单位记录（输入框失焦触发记录），撤销和重做提示词，支持跨节点查看提示词历史记录。`

![历史](https://github.com/user-attachments/assets/85868b9e-1bf5-4789-9a71-97af80ef2bc8)


#### 📜Markdown和节点文档翻译

`支持翻译note节点和Markdown节点，并保持格式`

![markdown](https://github.com/user-attachments/assets/c2ac1266-f8c1-4b27-ba41-13c5b5e5e689)

`支持翻译英文节点文档（beta：仅在英文节点才会出现翻译按钮）`

![nodedoc](https://github.com/user-attachments/assets/32c9a712-20c3-4b5e-b331-bfb885b7b5d4)



### 📒节点介绍
节点分类`✨Prompt Assistant`

#### **🔹翻译节点**
`✨Prompt Assistant → 提示词翻译`

<img width="1700" height="700" alt="翻译节点" src="https://github.com/user-attachments/assets/9dbc9fc9-1b91-43b6-822e-d598b2c8168f" />


#### **🔹提示词优化节点**
`✨Prompt Assistant → 提示词优化`

<img width="1700" height="911" alt="扩写节点" src="https://github.com/user-attachments/assets/ea821506-d684-4526-9119-621bb0467ddf" />


#### **🔹图像反推节点**
`✨Prompt Assistant → 图像反推提示词`

`可以反推图像、结合视觉模型优化图像编辑指令`

<img width="1700" height="800" alt="图像反推节点" src="https://github.com/user-attachments/assets/8ff3ac96-724a-48d0-8e15-23fe0b28bec1" />

<img width="1700" height="800" alt="编辑模型配合视觉理解" src="https://github.com/user-attachments/assets/a95dc0f4-1d46-438f-a242-4087f6e8361a" />




#### **🔹视频反推节点**
`✨Prompt Assistant → 视频反推提示词`

<img width="1700" height="1080" alt="视频反推节点" src="https://github.com/user-attachments/assets/0143096b-24d5-4308-82ff-e0a99144db0b" />
<img width="1700" height="1102" alt="选取帧工具" src="https://github.com/user-attachments/assets/96c2bd08-b26c-4df1-b32c-be8e20328c97" />





## **📦 安装方法**

### ⚠️旧版本迁移注意事项

`如果您安装过提示词小助手2.0之前的版本，请注意备份原插件目录下的config目录。避免api配置、自定义规则、自定义标签数据丢失！`

如果您之前是通过**Manager**安装则直接更新即可，如果您使用的是手动安装，建议删除旧的插件目录（记得备份config目录！！）将新的插件放入到`custom\custom_nodes`目录，再将需要恢复的配置文件放回config目录

#### **从ComfyUI Manager中安装**

在Manager中输入`Prompt Assistant`或`提示词小助手`，点击`Install`，选择最新版本安装。

<img width="1800" height="1098" alt="安装" src="https://github.com/user-attachments/assets/167eb467-a77d-4a37-a95b-e935ca354284" />



#### **克隆代码仓库**


1. 导航到您的ComfyUI自定义节点文件夹:
   ```bash
   cd ComfyUI/custom_nodes
   ```

2. 克隆这个代码仓库:
   ```bash
   git clone https://github.com/idleeyan/ComfyUI-Prompt-Assistant.git
   ```

3. 重启 ComfyUI：

#### **下载插件压缩包**

1.  从[克隆仓库](https://github.com/idleeyan/ComfyUI-Prompt-Assistant/releases)中下载最新版本

    解压缩到 `ComfyUI/custom_nodes` 目录下

    `⚠️注意：建议将插件目录名称修改为：prompt-assistant，以符合ComfyUI规范`
<img width="600" height="276" alt="github安装" src="https://github.com/user-attachments/assets/99783a78-6e0b-42aa-8f9e-7146ebcef5fd" />


2. 重启 ComfyUI

### 数据自动迁移

新版本能自动将用户的api配置、自定义规则、自定义标签进行升级和迁移。您可以根据自己的需要，将要做迁移的文件，放置在`prompt-assistant\config`目录下。如果不选择迁移，重新安装后，API配置信息，需要重新手动配置！ 可迁移文件有
新版本的小助手配置文件储存在`ComfyUI\user\default\prompt-assistant`目录下，

<img width="600" height="419" alt="迁移" src="https://github.com/user-attachments/assets/90b8f90f-51df-4537-b735-ae07c3cdff7f" />






## **⚙️ 配置说明**

### 配置API Key，并配置模型

<img width="1593" height="1119" alt="进入配置页面" src="https://github.com/user-attachments/assets/ea01c0bc-fe0f-40be-991c-d7833965213a" />

<img width="1569" height="1137" alt="apI配置窗口" src="https://github.com/user-attachments/assets/9d982773-2939-480b-a691-bb89a227a9ff" />


### 服务说明

您可以需求新增服务商，或者选择内置的服务商进行使用：

`⚠️免责声明：本插件仅提供API调用工具，第三方服务责任与本插件无关，插件所涉用户配置信息均存储于本地。对于因账号使用产生的任何问题，本插件不承担责任！`


​**百度翻译（机器翻译**​）：[百度通用文本翻译申请入口](https://fanyi-api.baidu.com/product/11)

`速度快，但是翻译质量一般。使用魔法时可能会导致无法请求每个月有免费500w额度`


**​智谱（大语言模型模型）：​**[智谱API申请入口](https://www.bigmodel.cn/invite?icode=Wz1tQAT40T9M8vwp%2F1db7nHEaazDlIZGj9HxftzTbt4%3D)

`速度快，无限额度；注意：模型有审查，如果请求内容违规，会返回空结果。并非插件bug。最近智谱开始限制请求频率了。`


**​xFlow-API聚合：​**[xFlow API申请入口](https://api.xflow.cc/register?aff=Z063)

`提供各类模型API聚合（如Gemini、nano Bannana、Grok、ChatGTP...），实现一个APIkey调用所有主流大模型，无需解决网络问题；`

**其他服务商可自行添加**



## **🎀特别感谢以下朋友！**

感谢群友为V2.0.0版本提供规则模板：阿丹、CJL、诺曼底







