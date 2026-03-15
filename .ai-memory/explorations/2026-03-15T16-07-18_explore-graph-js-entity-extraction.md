---
id: exp_febd0ba8
ts: 2026-03-15T16:07:18.390Z
agent: Explore
query: "In <USER_HOME>/project-memory/scripts/graph.js, how does extractEntitiesFromText work? What patterns does it look for? Give a concise answer (5-10 lines max)."
files_mentioned: ["/Users/sungoyal/project-memory/scripts/graph.js","Script.cs","config.json","System.Xml","FlaUI.C"]
entities: ["pascalcase","xpathdocument","flauitoolhandler","domservice","testrunner","getpagesourceasync","flaui","graph.js","script.cs","config.json","answer","camelcase","segments","words","system.xml","git","npm","docker","az"]
tags: ["project-memory","js"]
---
{
  "status": "completed",
  "prompt": "In <USER_HOME>/project-memory/scripts/graph.js, how does extractEntitiesFromText work? What patterns does it look for? Give a concise answer (5-10 lines max).",
  "agentId": "a26f10a",
  "content": [
    {
      "type": "text",
      "text": "The `extractEntitiesFromText` function (lines 182-249) extracts entities using 9 regex patterns:\n\n1. **PascalCase** (mixed case): XPathDocument, FlaUIToolHandler\n2. **Standard PascalCase**: DomService, TestRunner\n3. **File names**: Script.cs, config.json\n4. **Method calls**: camelCase(\n5. **Async methods**: GetPageSourceAsync\n6. **Namespaces**: System.Xml, FlaUI.Core\n7. **CLI tools**: git, npm, docker, az, etc.\n8. **URLs**: Extracts domain + meaningful path segments (excludes localhost, numeric paths, and \"_apis\")\n9. **Stop filter**: Excludes 50+ common words (the, this, function, return, etc.) and entities <4 chars\n\nAll matches are lowercased. The function returns an array of unique entity strings."
    }
  ],
  "totalDurationMs": 10298,
  "totalTokens": 31565,
  "totalToolUseCount": 1,
  "usage": {
    "input_tokens": 5,
    "cache_creation_input_tokens": 7678,
    "cache_read_input_tokens": 23665,
    "output_tokens": 217,
    "server_tool_use": {
      "web_search_requests": 0,
      "web_fetch_requests": 0
    },
    "service_tier": "standard",
    "cache_creation": {
      "ephemeral_1h_input_tokens": 0,
      "ephemeral_5m_input_tokens": 7678
    }
  }
}