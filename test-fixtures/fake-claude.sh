#!/bin/sh
# 测试用的假 claude：--permission-mode auto 时报错退出，其他模式输出一个成功结果。
for a in "$@"; do
  if [ "$prev" = "--permission-mode" ] && [ "$a" = "auto" ]; then
    echo "error: option '--permission-mode <mode>' argument 'auto' is invalid" >&2
    exit 1
  fi
  prev="$a"
done
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"README.md"}}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"好了","total_cost_usd":0.001,"permission_denials":[]}'
