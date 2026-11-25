#!/usr/bin/env bash
# P5-06 磁盘守卫（docs/09 §6「磁盘到阈值时停止新批次」）。
#
# 用法：check-disk-space.sh <检查路径> <最少可用 MB>
# 可用空间 >= 阈值：exit 0；否则 stderr 报告并 exit 1（systemd ExecStartPre 失败
# 即拒绝启动新批次）。
#
# 只读检查，不做任何清理；清理与告警属运维流程（docs/09 §10）。
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "用法：check-disk-space.sh <检查路径> <最少可用 MB>" >&2
  exit 2
fi

CHECK_PATH="$1"
THRESHOLD_MB="$2"

case "$THRESHOLD_MB" in
  ''|*[!0-9]*)
    echo "阈值必须为非负整数 MB：$THRESHOLD_MB" >&2
    exit 2
    ;;
esac

if [ ! -d "$CHECK_PATH" ]; then
  echo "检查路径不存在：$CHECK_PATH" >&2
  exit 2
fi

# df -P（POSIX）：总 1K 块 / 已用 / 可用 / 挂载点，第 4 列为可用 1K 块。
AVAILABLE_KB="$(df -Pk "$CHECK_PATH" | awk 'NR==2 {print $4}')"
AVAILABLE_MB=$(( AVAILABLE_KB / 1024 ))

if [ "$AVAILABLE_MB" -lt "$THRESHOLD_MB" ]; then
  echo "磁盘可用空间不足：${AVAILABLE_MB}MB < 阈值 ${THRESHOLD_MB}MB（路径 $CHECK_PATH）；拒绝启动新批次" >&2
  exit 1
fi

echo "磁盘检查通过：${AVAILABLE_MB}MB 可用 >= 阈值 ${THRESHOLD_MB}MB（路径 $CHECK_PATH）"
