import { isAbsolute } from "path";

/**
 * Validates sub-agent tool call parameters before execution.
 * Returns null if valid, or an error message string if invalid.
 */
export function validateToolCall(
  toolName: string,
  args: Record<string, any> = {}
): string | null {
  let toolValidationError: string | null = null;

  // finish_task is always allowed - it's the termination signal, not an executable tool
  if (toolName === "finish_task") {
    return null; // Always valid, no parameters required beyond optional message/status
  }

  if (toolName === "save_file") {
    if (Array.isArray(args.files)) {
      for (const file of args.files) {
        const fileName = file.file_name || file.name || file.path;
        const fileContent = file.content || file.data;
        if (!fileName && !fileContent) {
          return `Tool 'save_file' batch mode requires [file_name, content] in all objects.`;
        } else if (!fileName) {
          return `Tool 'save_file' batch missing 'file_name'. Hint: Use 'file_name'.`;
        } else if (!fileContent) {
          return `Tool 'save_file' batch missing 'content'. Hint: Use 'content'.`;
        } else if (isAbsolute(fileName)) {
          return `Tool 'save_file' batch rejected absolute path: '${fileName}'. SECURITY: Files can only be saved within workspace.`;
        }
      }
      return null;
    }

    const fileName = args.file_name || args.name || args.path;
    const fileContent = args.content || args.data;

    if (!fileName && fileContent === undefined) {
      toolValidationError = `Tool 'save_file' requires parameters: [file_name, content]. Provided keys: ${Object.keys(args).join(", ") || "none"}.`;
    } else if (!fileName) {
      toolValidationError = `Tool 'save_file' missing required parameter: 'file_name'.`;
    } else if (fileContent === undefined || fileContent === null) {
      toolValidationError = `Tool 'save_file' missing required parameter: 'content'.`;
    } else if (isAbsolute(fileName)) {
      toolValidationError = `Tool 'save_file' rejected absolute path: '${fileName}'. SECURITY: Files can only be saved within workspace. Use relative path like 'test.html'.`;
    }
  }

  if (toolName === "read_file") {
    // Accept file_name, path, or name for consistency with parser normalization
    const fileName = args.file_name || args.path || args.name;
    if (!fileName) {
      toolValidationError = `Tool 'read_file' requires parameter: [file_name]. Provided keys: ${Object.keys(args).join(", ") || "none"}. Hint: Use 'file_name' (not 'path', 'filepath', or 'file_path').`;
    } else if (isAbsolute(fileName)) {
      toolValidationError = `Tool 'read_file' rejected absolute path. SECURITY: Only workspace paths allowed.`;
    }
  }

  if (toolName === "replace_text_in_file") {
    const fileName = args.file_name || args.path || args.name;
    const missing: string[] = [];
    if (!fileName) missing.push("file_name");
    if (!args.old_string) missing.push("old_string");
    if (!args.new_string) missing.push("new_string");
    if (missing.length > 0) {
      toolValidationError = `Tool 'replace_text_in_file' missing parameters: [${missing.join(", ")}]. Provided keys: ${Object.keys(args).join(", ") || "none"}.`;
    } else if (isAbsolute(fileName)) {
      toolValidationError = `Tool 'replace_text_in_file' rejected absolute path. SECURITY: Only workspace paths allowed.`;
    }
  }

  if (toolName === "multi_replace_text") {
    const fileName = args.file_name || args.path || args.name;
    if (!fileName) {
      toolValidationError = `Tool 'multi_replace_text' missing parameter: 'file_name'.`;
    } else if (isAbsolute(fileName)) {
      toolValidationError = `Tool 'multi_replace_text' rejected absolute path. SECURITY: Only workspace paths allowed.`;
    } else if (!Array.isArray(args.replacements) || args.replacements.length === 0) {
      toolValidationError = `Tool 'multi_replace_text' requires an array 'replacements' with at least one replacement object.`;
    } else {
      for (let i = 0; i < args.replacements.length; i++) {
        const rep = args.replacements[i];
        if (!rep.start_line || !rep.end_line || !rep.old_string || typeof rep.new_string !== "string") {
          toolValidationError = `Tool 'multi_replace_text' replacements[${i}] missing required fields (start_line, end_line, old_string, new_string).`;
          break;
        }
      }
    }
  }

  // ── File tools ─────────────────────────────────────────────────────────────

  if (toolName === "read_file_range") {
    const fileName = args.file_name || args.path || args.name;
    if (!fileName) {
      return `Tool 'read_file_range' requires 'file_name'. Provided keys: ${Object.keys(args).join(", ") || "none"}.`;
    }
    if (isAbsolute(fileName)) return `Tool 'read_file_range' rejected absolute path. Only workspace paths allowed.`;
    if (args.start_line === undefined || args.start_line === null) return `Tool 'read_file_range' requires 'start_line'.`;
    if (args.end_line === undefined || args.end_line === null) return `Tool 'read_file_range' requires 'end_line'.`;
    if (Number(args.start_line) > Number(args.end_line)) return `Tool 'read_file_range': start_line (${args.start_line}) must be ≤ end_line (${args.end_line}).`;
  }

  if (toolName === "search_in_file") {
    const fileName = args.file_name || args.path || args.name;
    if (!fileName) return `Tool 'search_in_file' requires 'file_name'. Provided keys: ${Object.keys(args).join(", ") || "none"}.`;
    if (isAbsolute(fileName)) return `Tool 'search_in_file' rejected absolute path. Only workspace paths allowed.`;
    if (!args.pattern) return `Tool 'search_in_file' requires 'pattern'. Provided keys: ${Object.keys(args).join(", ") || "none"}.`;
  }

  if (toolName === "append_file") {
    const fileName = args.file_name || args.path || args.name;
    if (!fileName) return `Tool 'append_file' requires 'file_name'. Provided keys: ${Object.keys(args).join(", ") || "none"}.`;
    if (isAbsolute(fileName)) return `Tool 'append_file' rejected absolute path. Only workspace paths allowed.`;
    if (args.content === undefined || args.content === null) return `Tool 'append_file' requires 'content'.`;
  }

  if (toolName === "find_files") {
    if (!args.pattern) return `Tool 'find_files' requires 'pattern' (filename substring to match). Provided keys: ${Object.keys(args).join(", ") || "none"}.`;
  }

  if (toolName === "fuzzy_find_local_files") {
    if (!args.query) return `Tool 'fuzzy_find_local_files' requires 'query'. Provided keys: ${Object.keys(args).join(", ") || "none"}.`;
  }

  if (toolName === "delete_files_by_pattern") {
    if (!args.pattern) return `Tool 'delete_files_by_pattern' requires 'pattern' (regex applied to filenames). Provided keys: ${Object.keys(args).join(", ") || "none"}.`;
    if (typeof args.pattern === "string" && args.pattern.length > 100) return `Tool 'delete_files_by_pattern': pattern too long (max 100 chars).`;
  }

  if (toolName === "insert_at_line") {
    const fileName = args.file_name || args.path || args.name;
    if (!fileName) return `Tool 'insert_at_line' requires 'file_name'. Provided keys: ${Object.keys(args).join(", ") || "none"}.`;
    if (isAbsolute(fileName)) return `Tool 'insert_at_line' rejected absolute path. Only workspace paths allowed.`;
    if (args.line_number === undefined || args.line_number === null) return `Tool 'insert_at_line' requires 'line_number'.`;
    if (args.content_to_insert === undefined || args.content_to_insert === null) return `Tool 'insert_at_line' requires 'content_to_insert'.`;
  }

  if (toolName === "delete_lines_in_file") {
    const fileName = args.file_name || args.path || args.name;
    if (!fileName) return `Tool 'delete_lines_in_file' requires 'file_name'. Provided keys: ${Object.keys(args).join(", ") || "none"}.`;
    if (isAbsolute(fileName)) return `Tool 'delete_lines_in_file' rejected absolute path. Only workspace paths allowed.`;
    if (args.start_line === undefined || args.start_line === null) return `Tool 'delete_lines_in_file' requires 'start_line'.`;
    if (args.end_line !== undefined && args.end_line !== null && Number(args.end_line) < Number(args.start_line)) {
      return `Tool 'delete_lines_in_file': end_line (${args.end_line}) must be ≥ start_line (${args.start_line}).`;
    }
  }

  if (toolName === "delete_path") {
    const targetPath = args.path || args.file_name || args.name;
    if (!targetPath) return `Tool 'delete_path' requires 'path'. Provided keys: ${Object.keys(args).join(", ") || "none"}.`;
    if (isAbsolute(targetPath)) return `Tool 'delete_path' rejected absolute path. Only workspace paths allowed.`;
  }

  if (toolName === "move_file") {
    if (!args.source) return `Tool 'move_file' requires 'source'. Provided keys: ${Object.keys(args).join(", ") || "none"}.`;
    if (!args.destination) return `Tool 'move_file' requires 'destination'. Provided keys: ${Object.keys(args).join(", ") || "none"}.`;
    if (isAbsolute(args.source)) return `Tool 'move_file' rejected absolute source path. Only workspace paths allowed.`;
    if (isAbsolute(args.destination)) return `Tool 'move_file' rejected absolute destination path. Only workspace paths allowed.`;
  }

  if (toolName === "copy_file") {
    if (!args.source) return `Tool 'copy_file' requires 'source'. Provided keys: ${Object.keys(args).join(", ") || "none"}.`;
    if (!args.destination) return `Tool 'copy_file' requires 'destination'. Provided keys: ${Object.keys(args).join(", ") || "none"}.`;
    if (isAbsolute(args.source)) return `Tool 'copy_file' rejected absolute source path. Only workspace paths allowed.`;
    if (isAbsolute(args.destination)) return `Tool 'copy_file' rejected absolute destination path. Only workspace paths allowed.`;
  }

  if (toolName === "make_directory") {
    const dirName = args.directory_name || args.path || args.name;
    if (!dirName) return `Tool 'make_directory' requires 'directory_name'. Provided keys: ${Object.keys(args).join(", ") || "none"}.`;
    if (isAbsolute(dirName)) return `Tool 'make_directory' rejected absolute path. Only workspace paths allowed.`;
  }

  if (toolName === "search_directory") {
    if (!args.pattern) return `Tool 'search_directory' requires 'pattern' (regex or string to search for). Provided keys: ${Object.keys(args).join(", ") || "none"}.`;
  }

  if (toolName === "rag_local_files") {
    if (!args.query) return `Tool 'rag_local_files' requires 'query'. Provided keys: ${Object.keys(args).join(", ") || "none"}.`;
  }

  // ── Web tools ──────────────────────────────────────────────────────────────

  if (toolName === "web_search" || toolName === "duckduckgo_search") {
    if (!args.query) return `Tool '${toolName}' requires 'query'. Provided keys: ${Object.keys(args).join(", ") || "none"}.`;
  }

  if (toolName === "wikipedia_search") {
    if (!args.query) return `Tool 'wikipedia_search' requires 'query'. Provided keys: ${Object.keys(args).join(", ") || "none"}.`;
  }

  if (toolName === "fetch_web_content" || toolName === "rag_web_content") {
    if (!args.url) return `Tool '${toolName}' requires 'url'. Provided keys: ${Object.keys(args).join(", ") || "none"}.`;
    if (typeof args.url === "string" && !args.url.startsWith("http://") && !args.url.startsWith("https://")) {
      return `Tool '${toolName}': url must start with http:// or https://. Got: '${args.url}'.`;
    }
    if (toolName === "rag_web_content" && !args.query) return `Tool 'rag_web_content' requires 'query'.`;
  }

  // ── Code tools ─────────────────────────────────────────────────────────────

  if (toolName === "run_python") {
    if (!args.python) return `Tool 'run_python' requires 'python' (code string). Provided keys: ${Object.keys(args).join(", ") || "none"}.`;
  }

  if (toolName === "run_javascript") {
    if (!args.javascript) return `Tool 'run_javascript' requires 'javascript' (code string). Provided keys: ${Object.keys(args).join(", ") || "none"}.`;
  }

  if (toolName === "run_test_command") {
    if (!args.command) return `Tool 'run_test_command' requires 'command' (e.g. 'npm test', 'pytest'). Provided keys: ${Object.keys(args).join(", ") || "none"}.`;
  }

  return toolValidationError;
}
