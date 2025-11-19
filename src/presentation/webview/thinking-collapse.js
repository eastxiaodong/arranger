/**
 * 思考过程折叠功能
 */

/**
 * 切换思考过程显示/隐藏
 * @param {string} thinkingId - 思考过程ID
 */
function toggleThinking(thinkingId) {
  const content = document.getElementById(`${thinkingId}-content`);
  const icon = document.getElementById(`${thinkingId}-icon`);
  
  if (!content || !icon) {
    console.warn(`Thinking elements not found for ID: ${thinkingId}`);
    return;
  }
  
  const isCollapsed = content.style.display === 'none';
  
  if (isCollapsed) {
    // 展开思考过程
    content.style.display = 'block';
    icon.textContent = '▼';
  } else {
    // 折叠思考过程
    content.style.display = 'none';
    icon.textContent = '▶';
  }
  
  console.log(`Thinking ${thinkingId} ${isCollapsed ? 'expanded' : 'collapsed'}`);
}

/**
 * 初始化所有思考过程的折叠状态
 */
function initializeThinkingCollapse() {
  // 查找所有思考过程内容
  const thinkingContents = document.querySelectorAll('.thinking-content');
  
  thinkingContents.forEach(content => {
    const id = content.id;
    if (id && id.endsWith('-content')) {
      const thinkingId = id.replace('-content', '');
      const icon = document.getElementById(`${thinkingId}-icon`);
      
      if (icon) {
        // 默认折叠状态
        content.style.display = 'none';
        icon.textContent = '▶';
      }
    }
  });
  
  console.log('Thinking collapse initialized');
}

/**
 * 添加思考过程样式
 */
function addThinkingStyles() {
  if (document.getElementById('thinking-styles')) {
    return; // 已经添加过了
  }
  
  const styleElement = document.createElement('style');
  styleElement.id = 'thinking-styles';
  styleElement.textContent = `
    .thinking-section {
      margin: 8px 0;
    }
    
    .thinking-toggle {
      cursor: pointer;
      margin-bottom: 8px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      user-select: none;
      transition: color 0.2s ease;
    }
    
    .thinking-toggle:hover {
      color: var(--vscode-foreground) !important;
    }
    
    .thinking-content {
      margin-bottom: 12px;
      padding: 12px;
      background: var(--vscode-textBlockQuote-background);
      border-left: 3px solid var(--vscode-textBlockQuote-border);
      border-radius: 4px;
      font-size: 12px;
      line-height: 1.4;
    }
    
    .thinking-step {
      margin-bottom: 8px;
    }
    
    .thinking-step:last-child {
      margin-bottom: 0 !important;
    }
    
    .thinking-step-header {
      font-weight: bold;
      color: var(--vscode-foreground);
      margin-bottom: 4px;
    }
    
    .thinking-step-content {
      color: var(--vscode-descriptionForeground);
      white-space: pre-wrap;
    }
  `;
  
  document.head.appendChild(styleElement);
}

/**
 * 处理思考过程标记
 * @param {string} content - 包含思考过程的内容
 * @returns {string} 处理后的HTML内容
 */
function processThinkingContent(content) {
  // 检测思考过程标记
  const thinkingRegex = /<thinking>([\s\S]*?)<\/thinking>/gi;
  const thinkingMatches = content.match(thinkingRegex);
  
  if (!thinkingMatches || thinkingMatches.length === 0) {
    // 没有思考过程，直接返回内容
    return content;
  }
  
  let finalContent = content;
  const thinkingContents = [];
  
  thinkingMatches.forEach(match => {
    // 移除thinking标签，保留内容
    const thinkingContent = match.replace(/<\/?thinking>/gi, '').trim();
    if (thinkingContent) {
      thinkingContents.push(thinkingContent);
    }
  });
  
  if (thinkingContents.length > 0) {
    // 移除原始的thinking标记
    finalContent = finalContent.replace(thinkingRegex, '');
    
    // 生成唯一的思考过程ID
    const thinkingId = `thinking-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    // 添加折叠的思考过程HTML
    finalContent += `
      <div class="thinking-section">
        <div class="thinking-toggle" onclick="toggleThinking('${thinkingId}')" style="cursor: pointer; margin-bottom: 8px; color: var(--vscode-descriptionForeground); font-size: 12px;">
          <span id="${thinkingId}-icon">▶</span>
          <span>思考过程 (${thinkingContents.length} 步)</span>
        </div>
        <div id="${thinkingId}-content" class="thinking-content" style="display: none; margin-bottom: 12px; padding: 12px; background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textBlockQuote-border); border-radius: 4px; font-size: 12px; line-height: 1.4;">
          ${thinkingContents.map((thinking, index) =>
            `<div class="thinking-step" style="margin-bottom: 8px;">
              <div class="thinking-step-header" style="font-weight: bold; color: var(--vscode-foreground); margin-bottom: 4px;">步骤 ${index + 1}:</div>
              <div class="thinking-step-content" style="color: var(--vscode-descriptionForeground); white-space: pre-wrap;">${escapeHtml(thinking)}</div>
            </div>`
          ).join('')}
        </div>
      </div>
    `;
  }
  
  return finalContent;
}

/**
 * HTML转义函数
 * @param {string} text - 需要转义的文本
 * @returns {string} 转义后的文本
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// 页面加载完成后初始化
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeThinkingCollapse);
} else {
  initializeThinkingCollapse();
}

// 添加样式
addThinkingStyles();

// 导出到全局作用域
window.toggleThinking = toggleThinking;
window.processThinkingContent = processThinkingContent;
window.initializeThinkingCollapse = initializeThinkingCollapse;