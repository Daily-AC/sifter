// Bridging the two languages these entries are actually written in.
//
// A design resource collected from a Chinese post is described in Chinese;
// the site itself describes itself in English. A user searching 网页设计灵感
// should find Awwwards even though nothing in that entry contains a Chinese
// character. Real semantic search would solve this, but it would also mean
// an API key and a network call before the first query — the thing this
// index exists to avoid.
//
// So: a small, honest, editable bilingual word list for the domains sifter
// is aimed at. It covers the vocabulary these posts actually use, degrades
// to plain keyword matching outside it, and anyone can extend it for their
// own field without touching the search code.

export const PAIRS = [
  // design & frontend
  ['design', '设计'], ['inspiration', '灵感'], ['gallery', '画廊', '图库'],
  ['component', '组件'], ['animation', '动画'], ['animated', '动画'],
  ['transition', '过渡', '转场'], ['font', '字体'], ['typography', '排版', '字体'],
  ['color', '配色', '颜色'], ['palette', '调色板', '配色'], ['icon', '图标'],
  ['illustration', '插画'], ['template', '模板'], ['theme', '主题'],
  ['layout', '布局'], ['landing', '落地页'], ['portfolio', '作品集'],
  ['ui', '界面'], ['ux', '交互'], ['interface', '界面'],
  ['award', '奖项', '获奖'], ['showcase', '展示'], ['minimal', '极简'],
  ['shader', '着色器'], ['3d', '三维'], ['motion', '动效'],
  ['dashboard', '仪表盘', '后台'], ['chart', '图表'], ['visualization', '可视化'],
  ['accessibility', '无障碍'], ['responsive', '响应式'], ['dark mode', '暗色'],
  // building & tooling
  ['open source', '开源'], ['free', '免费'], ['library', '库'],
  ['framework', '框架'], ['plugin', '插件'], ['tool', '工具'],
  ['generator', '生成器'], ['editor', '编辑器'], ['playground', '演练场'],
  ['docs', '文档'], ['tutorial', '教程'], ['course', '课程'],
  // ai
  ['agent', '智能体'], ['prompt', '提示词'], ['model', '模型'],
  ['image', '图片', '图像'], ['video', '视频'], ['audio', '音频'],
  ['voice', '语音'], ['search', '搜索'], ['dataset', '数据集'],
];

const MAP = new Map();
for (const group of PAIRS) {
  for (const w of group) {
    const k = w.toLowerCase();
    if (!MAP.has(k)) MAP.set(k, new Set());
    for (const other of group) if (other !== w) MAP.get(k).add(other.toLowerCase());
  }
}

/** Cross-language equivalents of a term, if any are known. */
export function synonyms(term) {
  return [...(MAP.get(String(term).toLowerCase()) || [])];
}

/**
 * Crude English suffix folding so `shader` matches `shaders`.
 * Not a real stemmer, and intentionally conservative: over-stemming turns
 * distinct words into the same token and makes results worse, not better.
 */
export function stem(t) {
  if (t.length < 4 || /[^a-z0-9]/.test(t)) return t;
  if (/[^aeiou]ies$/.test(t)) return t.slice(0, -3) + 'y';
  if (/(sses|shes|ches|xes)$/.test(t)) return t.slice(0, -2);
  if (/[^s]s$/.test(t)) return t.slice(0, -1);
  if (t.length > 5 && /ing$/.test(t)) return t.slice(0, -3);
  if (t.length > 5 && /ed$/.test(t)) return t.slice(0, -2);
  return t;
}
