#!/bin/bash
# Laurel Proxy Demo — polished asciinema recording
# Emulated CLI + simulated AI agent interaction

# --- Colors ---
RED='\033[1;31m'
GREEN='\033[1;32m'
YELLOW='\033[1;33m'
BLUE='\033[1;34m'
MAGENTA='\033[1;35m'
CYAN='\033[1;36m'
WHITE='\033[1;37m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

# --- Helpers ---

type_text() {
  local text="$1"
  local delay="${2:-0.04}"
  for (( i=0; i<${#text}; i++ )); do
    printf '%s' "${text:$i:1}"
    sleep "$delay"
  done
}

shell_prompt() {
  printf "${GREEN}❯ ${RESET}"
}

agent_input() {
  echo ""
  printf "${MAGENTA}You: ${RESET}"
}

agent_think() {
  printf "${DIM}"
  local frames=("⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏")
  for round in 1 2 3 4 5 6 7 8; do
    for frame in "${frames[@]}"; do
      printf "\r  ${frame} Thinking..."
      sleep 0.08
    done
  done
  printf "\r                    \r"
  printf "${RESET}"
}

agent_say() {
  printf "  ${CYAN}▌${RESET} "
  local words=($1)
  for word in "${words[@]}"; do
    printf '%b ' "$word"
    sleep 0.07
  done
  echo ""
}

agent_tool() {
  echo ""
  printf "  ${DIM}┌─ ${YELLOW}⚡ Tool: ${RESET}${WHITE}$1${RESET}\n"
  printf "  ${DIM}│${RESET}  ${CYAN}$2${RESET}\n"
  printf "  ${DIM}└──────${RESET}\n"
  sleep 0.8
}

print_agent_output() {
  echo ""
  printf "  ${DIM}│${RESET}\n"
  sleep 0.15
  printf "  ${DIM}│${RESET}  ${WHITE}${BOLD}POST${RESET} ${BLUE}https://api.example.com/webhooks${RESET} ${RED}→ 422${RESET} ${DIM}(218ms)${RESET}\n"
  sleep 0.15
  printf "  ${DIM}│${RESET}\n"
  printf "  ${DIM}│${RESET}  ${YELLOW}Request${RESET}\n"
  sleep 0.1
  printf "  ${DIM}│${RESET}  ${DIM}Content-Type:${RESET} application/json\n"
  sleep 0.1
  printf "  ${DIM}│${RESET}  ${DIM}Body:${RESET}         ${WHITE}{\"event\": \"invoice.paid\", \"amount\": 4999}${RESET}\n"
  sleep 0.15
  printf "  ${DIM}│${RESET}\n"
  printf "  ${DIM}│${RESET}  ${YELLOW}Response${RESET}\n"
  sleep 0.1
  printf "  ${DIM}│${RESET}  ${DIM}Status:${RESET}       ${RED}422 Unprocessable Entity${RESET}\n"
  sleep 0.1
  printf "  ${DIM}│${RESET}  ${DIM}Body:${RESET}         ${WHITE}{\"error\": \"missing required field: idempotency_key\"}${RESET}\n"
  sleep 0.1
  printf "  ${DIM}│${RESET}  ${DIM}Error:${RESET}        ${RED}true${RESET}\n"
  printf "  ${DIM}│${RESET}\n"
}

# ============================================================
# SCENE 1: Start laurel-proxy
# ============================================================
clear
echo ""
sleep 1

shell_prompt
type_text "laurel-proxy start" 0.06
sleep 0.5
echo ""
echo ""

# Emulated CLI banner
sleep 0.5
printf "${CYAN}  _                      _   ___                  ${RESET}\n"
sleep 0.05
printf "${CYAN} | |   __ _ _  _ _ _ ___| | | _ \\_ _ _____ ___  _ ${RESET}\n"
sleep 0.05
printf "${CYAN} | |__/ _\` | || | '_/ -_) | |  _/ '_/ _ \\ \\ / || |${RESET}\n"
sleep 0.05
printf "${CYAN} |____\\__,_|\\_,_|_| \\___|_| |_| |_| \\___/_\\_\\\\_, |${RESET}\n"
sleep 0.05
printf "${CYAN}                                             |__/ ${RESET}\n"
echo ""
sleep 0.6

printf "  ${GREEN}●${RESET} Proxy    ${CYAN}http://127.0.0.1:8080${RESET}\n"
sleep 0.2
printf "  ${GREEN}●${RESET} Web UI   ${CYAN}http://127.0.0.1:8081${RESET}\n"
sleep 0.2
printf "  ${GREEN}●${RESET} Network  ${CYAN}http://192.168.1.42:8081${RESET}\n"
echo ""
sleep 0.8

printf "  ${GREEN}✔${RESET} CA certificate installed and trusted\n"
sleep 0.7
printf "  ${GREEN}✔${RESET} System proxy enabled ${DIM}(all traffic routed through Laurel Proxy)${RESET}\n"
sleep 0.7
echo ""
printf "  ${DIM}Capturing traffic... press Ctrl+C to stop${RESET}\n"
sleep 3

# ============================================================
# SCENE 2: Start the AI agent
# ============================================================
echo ""
echo ""
shell_prompt
type_text "ai-agent" 0.06
sleep 0.4
echo ""
echo ""
printf "  ${GREEN}●${RESET} AI coding agent connected ${DIM}(laurel-proxy plugin loaded)${RESET}\n"
sleep 2.5

# ============================================================
# SCENE 3: AI agent debugging
# ============================================================

agent_input
sleep 0.5
type_text "Some of my webhook calls are failing. Can you check what's going wrong?" 0.035
sleep 1
echo ""
echo ""

agent_think
echo ""
agent_say "Let me check the captured traffic for failing requests."
sleep 0.8

agent_tool "Bash" "laurel-proxy requests --failed --format agent"

print_agent_output
sleep 3.5

# ============================================================
# SCENE 4: Agent diagnosis
# ============================================================
echo ""
agent_say "Found it. Your POST to ${BLUE}api.example.com/webhooks${RESET} is returning"
agent_say "a ${RED}422 Unprocessable Entity${RESET}."
sleep 0.8
echo ""
agent_say "The response body says: ${WHITE}\"missing required field: idempotency_key\"${RESET}."
agent_say "Your payload sends ${WHITE}event${RESET} and ${WHITE}amount${RESET} but the API requires an"
agent_say "${WHITE}idempotency_key${RESET} field for webhook delivery."
sleep 1
echo ""
agent_say "${YELLOW}Fix:${RESET} Add an ${WHITE}idempotency_key${RESET} to your webhook payload."

# Hold the final frame
sleep 8
