export interface ModeDefinition {
  mode: 'yolo' | 'plan' | 'orchestrator';
  enabled_tools?: string[];     // tool names to enable; undefined or empty = all tools
  prompt_suffix?: string;       // text injected into system prompt
  description?: string;         // human-readable description for UI
  border_label?: string;        // label displayed on editor border (e.g. " YOLO ")
  border_style?: 'accent' | 'warning' | 'success' | 'muted'; // future theming
}
