#!/usr/bin/env node
"use strict";

/**
 * Tree-sitter AST parser for code graph extraction.
 * Uses web-tree-sitter (WASM) — no native compilation needed.
 *
 * Supports: C#, Python, JavaScript/TypeScript
 *
 * For each source file, extracts:
 *   - Nodes: File, Class, Interface, Function, Method, Property, Type
 *   - Edges: CONTAINS, CALLS, IMPORTS, INHERITS, TESTED_BY
 *
 * Usage:
 *   const parser = require('./code-parser');
 *   await parser.init();
 *   const { nodes, edges } = await parser.parseFile(filePath, fileContent, language);
 */

const path = require("path");
const fs = require("fs");

let ParserClass = null;
let LanguageClass = null;
const loadedLanguages = {};
let initialized = false;

const WASM_DIR = path.join(__dirname, "..", "node_modules", "@vscode", "tree-sitter-wasm", "wasm");

const LANGUAGE_MAP = {
  cs: "tree-sitter-c-sharp",
  csharp: "tree-sitter-c-sharp",
  py: "tree-sitter-python",
  python: "tree-sitter-python",
  js: "tree-sitter-javascript",
  javascript: "tree-sitter-javascript",
  ts: "tree-sitter-typescript",
  typescript: "tree-sitter-typescript",
  jsx: "tree-sitter-javascript",
  tsx: "tree-sitter-tsx",
};

const EXT_TO_LANG = {
  ".cs": "cs",
  ".py": "py",
  ".js": "js",
  ".jsx": "js",
  ".ts": "ts",
  ".tsx": "ts",
  ".mjs": "js",
  ".cjs": "js",
};

// ── Initialization ──

async function init() {
  if (initialized) return;
  const wts = require("web-tree-sitter");
  ParserClass = wts.Parser;
  LanguageClass = wts.Language;
  await ParserClass.init();
  initialized = true;
}

async function getLanguage(langKey) {
  const wasmName = LANGUAGE_MAP[langKey];
  if (!wasmName) return null;
  if (loadedLanguages[wasmName]) return loadedLanguages[wasmName];

  const wasmPath = path.join(WASM_DIR, wasmName + ".wasm");
  if (!fs.existsSync(wasmPath)) return null;

  const lang = await LanguageClass.load(wasmPath);
  loadedLanguages[wasmName] = lang;
  return lang;
}

function detectLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_LANG[ext] || null;
}

// ── File Parsing ──

async function parseFile(filePath, content, language) {
  if (!initialized) await init();
  const langKey = language || detectLanguage(filePath);
  if (!langKey) return { nodes: [], edges: [] };

  const lang = await getLanguage(langKey);
  if (!lang) return { nodes: [], edges: [] };

  const parser = new ParserClass();
  parser.setLanguage(lang);

  const tree = parser.parse(content);
  const normalizedPath = filePath.replace(/\\/g, "/");

  const nodes = [];
  const edges = [];

  // File node
  const fileQualified = normalizedPath;
  nodes.push({
    kind: "File",
    name: path.basename(filePath),
    qualified_name: fileQualified,
    file_path: normalizedPath,
    line_start: 1,
    line_end: content.split("\n").length,
    language: langKey,
    signature: null,
    parent_name: null,
  });

  if (langKey === "cs" || langKey === "csharp") {
    extractCSharp(tree.rootNode, normalizedPath, nodes, edges);
  } else if (langKey === "py" || langKey === "python") {
    extractPython(tree.rootNode, normalizedPath, nodes, edges);
  } else {
    extractJavaScript(tree.rootNode, normalizedPath, nodes, edges);
  }

  parser.delete();
  tree.delete();

  return { nodes, edges };
}

// ── C# Extraction ──

function extractCSharp(root, filePath, nodes, edges) {
  const namespace = findFirst(root, "namespace_declaration") || findFirst(root, "file_scoped_namespace_declaration");
  const nsName = namespace ? textOfChild(namespace, "qualified_name") || textOfChild(namespace, "name") || "" : "";

  walkCSharpNode(root, filePath, nsName, null, nodes, edges);
}

function walkCSharpNode(node, filePath, nsName, parentQualified, nodes, edges) {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    const type = child.type;

    if (type === "using_directive") {
      const nameNode = findFirst(child, "qualified_name") || findFirst(child, "identifier");
      if (nameNode) {
        edges.push({
          kind: "IMPORTS",
          source_qualified: filePath,
          target_qualified: nameNode.text,
          file_path: filePath,
          line: child.startPosition.row + 1,
        });
      }
    } else if (type === "class_declaration" || type === "interface_declaration" || type === "struct_declaration" || type === "enum_declaration" || type === "record_declaration") {
      const nameNode = findFirst(child, "identifier");
      if (!nameNode) continue;
      const name = nameNode.text;
      const kind = type === "interface_declaration" ? "Interface"
        : type === "enum_declaration" ? "Type"
        : "Class";
      const qualified = parentQualified ? `${parentQualified}.${name}` : (nsName ? `${nsName}.${name}` : `${filePath}::${name}`);

      nodes.push({
        kind,
        name,
        qualified_name: qualified,
        file_path: filePath,
        line_start: child.startPosition.row + 1,
        line_end: child.endPosition.row + 1,
        language: "cs",
        signature: extractCSharpClassSig(child),
        parent_name: parentQualified || (nsName || filePath),
      });

      if (parentQualified) {
        edges.push({ kind: "CONTAINS", source_qualified: parentQualified, target_qualified: qualified, file_path: filePath, line: child.startPosition.row + 1 });
      }

      // Base types
      const baseList = findFirst(child, "base_list");
      if (baseList) {
        for (let bi = 0; bi < baseList.childCount; bi++) {
          const baseType = baseList.child(bi);
          if (baseType.type === "simple_base_type" || baseType.type === "identifier" || baseType.type === "generic_name" || baseType.type === "qualified_name") {
            const baseName = baseType.text.replace(/<.*>$/, ""); // strip generic params
            if (baseName && baseName !== "," && baseName !== ":") {
              edges.push({ kind: "INHERITS", source_qualified: qualified, target_qualified: baseName, file_path: filePath, line: child.startPosition.row + 1 });
            }
          }
        }
      }

      // Recurse into class body for methods, properties, nested types
      walkCSharpNode(child, filePath, nsName, qualified, nodes, edges);

    } else if (type === "method_declaration" || type === "constructor_declaration") {
      const nameNode = findFirst(child, "identifier");
      if (!nameNode) continue;
      const name = nameNode.text;
      const qualified = parentQualified ? `${parentQualified}.${name}` : `${filePath}::${name}`;
      const sig = extractCSharpMethodSig(child);

      nodes.push({
        kind: type === "constructor_declaration" ? "Constructor" : "Method",
        name,
        qualified_name: qualified,
        file_path: filePath,
        line_start: child.startPosition.row + 1,
        line_end: child.endPosition.row + 1,
        language: "cs",
        signature: sig,
        parent_name: parentQualified || filePath,
      });

      if (parentQualified) {
        edges.push({ kind: "CONTAINS", source_qualified: parentQualified, target_qualified: qualified, file_path: filePath, line: child.startPosition.row + 1 });
      }

      // Check for test attributes
      if (hasTestAttribute(child)) {
        // Mark as TESTED_BY: test method → tested class
        if (parentQualified) {
          edges.push({ kind: "TESTED_BY", source_qualified: qualified, target_qualified: parentQualified, file_path: filePath, line: child.startPosition.row + 1 });
        }
      }

      // Extract method calls
      extractCallsFromBody(child, qualified, filePath, edges);

    } else if (type === "property_declaration") {
      const nameNode = findFirst(child, "identifier");
      if (!nameNode) continue;
      const name = nameNode.text;
      const qualified = parentQualified ? `${parentQualified}.${name}` : `${filePath}::${name}`;

      nodes.push({
        kind: "Property",
        name,
        qualified_name: qualified,
        file_path: filePath,
        line_start: child.startPosition.row + 1,
        line_end: child.endPosition.row + 1,
        language: "cs",
        signature: extractPropertySig(child),
        parent_name: parentQualified || filePath,
      });

      if (parentQualified) {
        edges.push({ kind: "CONTAINS", source_qualified: parentQualified, target_qualified: qualified, file_path: filePath, line: child.startPosition.row + 1 });
      }
    } else if (type === "namespace_declaration" || type === "file_scoped_namespace_declaration") {
      const nsNode = findFirst(child, "qualified_name") || findFirst(child, "name");
      const newNs = nsNode ? nsNode.text : nsName;
      walkCSharpNode(child, filePath, newNs, parentQualified, nodes, edges);
    } else if (type === "declaration_list" || type === "block" || type === "compilation_unit") {
      walkCSharpNode(child, filePath, nsName, parentQualified, nodes, edges);
    }
  }
}

function extractCSharpClassSig(node) {
  const parts = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === "modifier" || child.type === "identifier" || child.type === "type_parameter_list") {
      parts.push(child.text);
    }
    if (child.type === "base_list" || child.type === "{" || child.type === "declaration_list") break;
  }
  return parts.join(" ").trim() || null;
}

function extractCSharpMethodSig(node) {
  const parts = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === "block" || child.type === "arrow_expression_clause" || child.type === ";") break;
    parts.push(child.text);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 200) || null;
}

function extractPropertySig(node) {
  const parts = [];
  for (let i = 0; i < Math.min(node.childCount, 5); i++) {
    const child = node.child(i);
    if (child.type === "accessor_list" || child.type === "=") break;
    parts.push(child.text);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 150) || null;
}

function hasTestAttribute(node) {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === "attribute_list") {
      const text = child.text.toLowerCase();
      if (text.includes("test") || text.includes("fact") || text.includes("theory") || text.includes("testmethod")) {
        return true;
      }
    }
  }
  return false;
}

function extractCallsFromBody(node, sourceQualified, filePath, edges) {
  const seen = new Set();
  walkForCalls(node, sourceQualified, filePath, edges, seen, 0);
}

function walkForCalls(node, sourceQualified, filePath, edges, seen, depth) {
  if (depth > 15) return; // prevent deep recursion
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === "invocation_expression" || child.type === "call_expression") {
      const callee = child.child(0);
      if (callee) {
        const callName = callee.text.replace(/\s+/g, "");
        if (callName.length > 0 && callName.length < 200 && !seen.has(callName)) {
          seen.add(callName);
          edges.push({
            kind: "CALLS",
            source_qualified: sourceQualified,
            target_qualified: callName,
            file_path: filePath,
            line: child.startPosition.row + 1,
          });
        }
      }
    }
    walkForCalls(child, sourceQualified, filePath, edges, seen, depth + 1);
  }
}

// ── Python Extraction ──

function extractPython(root, filePath, nodes, edges) {
  walkPythonNode(root, filePath, null, nodes, edges);
}

function walkPythonNode(node, filePath, parentQualified, nodes, edges) {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    const type = child.type;

    if (type === "import_statement" || type === "import_from_statement") {
      edges.push({
        kind: "IMPORTS",
        source_qualified: filePath,
        target_qualified: child.text.replace(/^(from\s+|import\s+)/, "").split(/\s+import\s+/)[0].trim(),
        file_path: filePath,
        line: child.startPosition.row + 1,
      });
    } else if (type === "class_definition") {
      const nameNode = findFirst(child, "identifier");
      if (!nameNode) continue;
      const name = nameNode.text;
      const qualified = parentQualified ? `${parentQualified}.${name}` : `${filePath}::${name}`;

      nodes.push({
        kind: "Class",
        name,
        qualified_name: qualified,
        file_path: filePath,
        line_start: child.startPosition.row + 1,
        line_end: child.endPosition.row + 1,
        language: "py",
        signature: extractPyClassSig(child),
        parent_name: parentQualified || filePath,
      });

      // Base classes
      const argList = findFirst(child, "argument_list");
      if (argList) {
        for (let ai = 0; ai < argList.childCount; ai++) {
          const arg = argList.child(ai);
          if (arg.type === "identifier" || arg.type === "attribute") {
            edges.push({ kind: "INHERITS", source_qualified: qualified, target_qualified: arg.text, file_path: filePath, line: child.startPosition.row + 1 });
          }
        }
      }

      const body = findFirst(child, "block");
      if (body) walkPythonNode(body, filePath, qualified, nodes, edges);

    } else if (type === "function_definition") {
      const nameNode = findFirst(child, "identifier");
      if (!nameNode) continue;
      const name = nameNode.text;
      const qualified = parentQualified ? `${parentQualified}.${name}` : `${filePath}::${name}`;

      nodes.push({
        kind: parentQualified ? "Method" : "Function",
        name,
        qualified_name: qualified,
        file_path: filePath,
        line_start: child.startPosition.row + 1,
        line_end: child.endPosition.row + 1,
        language: "py",
        signature: extractPyFuncSig(child),
        parent_name: parentQualified || filePath,
      });

      if (parentQualified) {
        edges.push({ kind: "CONTAINS", source_qualified: parentQualified, target_qualified: qualified, file_path: filePath, line: child.startPosition.row + 1 });
      }

      // Check for test decorators/names
      if (name.startsWith("test_") || hasTestDecorator(child)) {
        if (parentQualified) {
          edges.push({ kind: "TESTED_BY", source_qualified: qualified, target_qualified: parentQualified, file_path: filePath, line: child.startPosition.row + 1 });
        }
      }

      extractCallsFromBody(child, qualified, filePath, edges);
    } else if (type === "block" || type === "module") {
      walkPythonNode(child, filePath, parentQualified, nodes, edges);
    }
  }
}

function extractPyClassSig(node) {
  const name = findFirst(node, "identifier");
  const args = findFirst(node, "argument_list");
  if (!name) return null;
  return `class ${name.text}${args ? args.text : ""}`;
}

function extractPyFuncSig(node) {
  const parts = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === "block" || child.type === ":") break;
    parts.push(child.text);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 200) || null;
}

function hasTestDecorator(node) {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === "decorator") {
      const text = child.text.toLowerCase();
      if (text.includes("test") || text.includes("pytest") || text.includes("fixture")) return true;
    }
  }
  return false;
}

// ── JavaScript/TypeScript Extraction ──

function extractJavaScript(root, filePath, nodes, edges) {
  walkJSNode(root, filePath, null, nodes, edges);
}

function walkJSNode(node, filePath, parentQualified, nodes, edges) {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    const type = child.type;

    if (type === "import_statement") {
      const source = findFirst(child, "string");
      if (source) {
        edges.push({
          kind: "IMPORTS",
          source_qualified: filePath,
          target_qualified: resolveRequirePath(source.text.replace(/['"]/g, ""), filePath),
          file_path: filePath,
          line: child.startPosition.row + 1,
        });
      }
    } else if (type === "class_declaration") {
      const nameNode = findChildByType(child, "identifier") || findChildByType(child, "type_identifier");
      if (!nameNode) continue;
      const name = nameNode.text;
      const qualified = parentQualified ? `${parentQualified}.${name}` : `${filePath}::${name}`;

      nodes.push({
        kind: "Class",
        name,
        qualified_name: qualified,
        file_path: filePath,
        line_start: child.startPosition.row + 1,
        line_end: child.endPosition.row + 1,
        language: filePath.match(/\.tsx?$/) ? "ts" : "js",
        signature: `class ${name}`,
        parent_name: parentQualified || filePath,
      });

      // Heritage (extends/implements)
      const heritage = findFirst(child, "class_heritage");
      if (heritage) {
        for (let hi = 0; hi < heritage.childCount; hi++) {
          const h = heritage.child(hi);
          if (h.type === "identifier" || h.type === "member_expression") {
            edges.push({ kind: "INHERITS", source_qualified: qualified, target_qualified: h.text, file_path: filePath, line: child.startPosition.row + 1 });
          }
        }
      }

      const body = findFirst(child, "class_body");
      if (body) walkJSNode(body, filePath, qualified, nodes, edges);

    } else if (type === "function_declaration" || type === "method_definition") {
      const nameNode = findChildByType(child, "identifier") || findChildByType(child, "property_identifier");
      if (!nameNode) continue;
      const name = nameNode.text;
      const qualified = parentQualified ? `${parentQualified}.${name}` : `${filePath}::${name}`;
      const kind = type === "method_definition" ? "Method" : "Function";

      nodes.push({
        kind,
        name,
        qualified_name: qualified,
        file_path: filePath,
        line_start: child.startPosition.row + 1,
        line_end: child.endPosition.row + 1,
        language: filePath.match(/\.tsx?$/) ? "ts" : "js",
        signature: extractJSFuncSig(child),
        parent_name: parentQualified || filePath,
      });

      if (parentQualified) {
        edges.push({ kind: "CONTAINS", source_qualified: parentQualified, target_qualified: qualified, file_path: filePath, line: child.startPosition.row + 1 });
      }

      // Test detection
      if (name.startsWith("test") || name.startsWith("it") || name.match(/^(describe|beforeEach|afterEach)$/)) {
        if (parentQualified) {
          edges.push({ kind: "TESTED_BY", source_qualified: qualified, target_qualified: parentQualified, file_path: filePath, line: child.startPosition.row + 1 });
        }
      }

      extractCallsFromBody(child, qualified, filePath, edges);

    } else if (type === "variable_declaration" || type === "lexical_declaration") {
      // Handle: const foo = function() {} or const foo = () => {}
      for (let vi = 0; vi < child.childCount; vi++) {
        const declarator = child.child(vi);
        if (declarator.type === "variable_declarator") {
          const nameNode = findChildByType(declarator, "identifier");
          const valueNode = declarator.childCount >= 3 ? declarator.child(declarator.childCount - 1) : null;
          if (nameNode && valueNode && (valueNode.type === "arrow_function" || valueNode.type === "function_expression" || valueNode.type === "function")) {
            const name = nameNode.text;
            const qualified = parentQualified ? `${parentQualified}.${name}` : `${filePath}::${name}`;

            nodes.push({
              kind: "Function",
              name,
              qualified_name: qualified,
              file_path: filePath,
              line_start: child.startPosition.row + 1,
              line_end: child.endPosition.row + 1,
              language: filePath.match(/\.tsx?$/) ? "ts" : "js",
              signature: `const ${name} = ${valueNode.type === "arrow_function" ? "() => {...}" : "function() {...}"}`,
              parent_name: parentQualified || filePath,
            });

            extractCallsFromBody(valueNode, qualified, filePath, edges);
          }

          // Handle: const foo = require('./bar') or const foo = require(path.join(__dirname, 'bar'))
          if (nameNode && valueNode && valueNode.type === "call_expression") {
            const callee = valueNode.child(0);
            if (callee && callee.text === "require") {
              const target = extractRequireTarget(valueNode, filePath);
              if (target) {
                edges.push({
                  kind: "IMPORTS",
                  source_qualified: filePath,
                  target_qualified: target,
                  file_path: filePath,
                  line: child.startPosition.row + 1,
                });
              }
            }
          }
        }
      }
    } else if (type === "expression_statement") {
      // Handle bare require() calls: require('./polyfill')
      const expr = child.child(0);
      if (expr && expr.type === "call_expression") {
        const callee = expr.child(0);
        if (callee && callee.text === "require") {
          const target = extractRequireTarget(expr, filePath);
          if (target) {
            edges.push({
              kind: "IMPORTS",
              source_qualified: filePath,
              target_qualified: target,
              file_path: filePath,
              line: child.startPosition.row + 1,
            });
          }
        }
      }
      // Also recurse into expression_statement children for other patterns
      walkJSNode(child, filePath, parentQualified, nodes, edges);
    } else if (type === "export_statement") {
      walkJSNode(child, filePath, parentQualified, nodes, edges);
    } else if (type === "program" || type === "statement_block" || type === "class_body") {
      walkJSNode(child, filePath, parentQualified, nodes, edges);
    }
  }
}

function extractJSFuncSig(node) {
  const parts = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === "statement_block" || child.type === "{") break;
    parts.push(child.text);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 200) || null;
}

// ── Require Path Resolution ──

function resolveRequirePath(rawPath, sourceFile) {
  // Only resolve relative paths (./foo, ../bar). Leave builtins/packages as-is.
  if (!rawPath.startsWith(".")) return rawPath;
  const dir = path.dirname(sourceFile);
  const resolved = path.resolve(dir, rawPath).replace(/\\/g, "/");
  // Try exact path, then with common extensions
  const candidates = [resolved];
  if (!path.extname(resolved)) {
    for (const ext of [".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"]) {
      candidates.push(resolved + ext);
    }
    candidates.push(resolved + "/index.js", resolved + "/index.ts");
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return resolved; // Best-effort: return resolved even if file not found
}

/**
 * Extract the import target from a require() call_expression node.
 * Handles:
 *   - require("./foo")           -> "./foo" (simple string)
 *   - require(path.join(__dirname, "foo.js")) -> resolved to absolute path
 */
function extractRequireTarget(callExpr, sourceFile) {
  const args = findFirst(callExpr, "arguments");
  if (!args) return null;

  // Case 1: Simple string argument — require("./foo")
  const firstArg = args.childCount > 1 ? args.child(1) : null; // child(0) is "("
  if (firstArg && (firstArg.type === "string" || firstArg.type === "template_string")) {
    const raw = firstArg.text.replace(/['"`]/g, "");
    return resolveRequirePath(raw, sourceFile);
  }

  // Case 2: path.join(__dirname, ...) pattern
  if (firstArg && firstArg.type === "call_expression") {
    const callee = firstArg.child(0);
    if (callee && callee.text === "path.join") {
      const joinArgs = findFirst(firstArg, "arguments");
      if (joinArgs) {
        const segments = [];
        let hasDirname = false;
        for (let i = 0; i < joinArgs.childCount; i++) {
          const a = joinArgs.child(i);
          if (a.type === "identifier" && a.text === "__dirname") {
            hasDirname = true;
            segments.push(path.dirname(sourceFile));
          } else if (a.type === "string" || a.type === "template_string") {
            segments.push(a.text.replace(/['"`]/g, ""));
          } else if (a.type === "member_expression" && a.text === "__dirname") {
            hasDirname = true;
            segments.push(path.dirname(sourceFile));
          }
        }
        if (hasDirname && segments.length >= 2) {
          const joined = path.join(...segments).replace(/\\/g, "/");
          // Try with extensions if no ext
          if (!path.extname(joined)) {
            for (const ext of [".js", ".ts", ".mjs", ".cjs"]) {
              const candidate = joined + ext;
              if (fs.existsSync(candidate)) return candidate;
            }
          }
          if (fs.existsSync(joined)) return joined;
          return joined;
        }
      }
    }
  }

  // Fallback: find any string in the arguments (deep search)
  const str = findFirst(args, "string");
  if (str) {
    const raw = str.text.replace(/['"]/g, "");
    return resolveRequirePath(raw, sourceFile);
  }
  return null;
}

// ── Tree Traversal Helpers ──

function findFirst(node, type) {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === type) return child;
    const found = findFirst(child, type);
    if (found) return found;
  }
  return null;
}

function findChildByType(node, type) {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i).type === type) return node.child(i);
  }
  return null;
}

function textOfChild(node, type) {
  const child = findFirst(node, type);
  return child ? child.text : null;
}

module.exports = {
  init,
  parseFile,
  detectLanguage,
  EXT_TO_LANG,
};
