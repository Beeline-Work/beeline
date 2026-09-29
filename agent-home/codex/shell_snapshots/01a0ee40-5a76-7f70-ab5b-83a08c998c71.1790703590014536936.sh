# Snapshot file
# Unset all aliases to avoid conflicts with functions
unalias -a 2>/dev/null || true
shopt -u array_expand_once
shopt -u assoc_expand_once
shopt -u autocd
shopt -u bash_source_fullpath
shopt -u cdable_vars
shopt -u cdspell
shopt -u checkhash
shopt -u checkjobs
shopt -s checkwinsize
shopt -s cmdhist
shopt -u compat31
shopt -u compat32
shopt -u compat40
shopt -u compat41
shopt -u compat42
shopt -u compat43
shopt -u compat44
shopt -s complete_fullquote
shopt -u direxpand
shopt -u dirspell
shopt -u dotglob
shopt -u execfail
shopt -u expand_aliases
shopt -u extdebug
shopt -u extglob
shopt -s extquote
shopt -u failglob
shopt -s force_fignore
shopt -s globasciiranges
shopt -s globskipdots
shopt -u globstar
shopt -u gnu_errfmt
shopt -u histappend
shopt -u histreedit
shopt -u histverify
shopt -s hostcomplete
shopt -u huponexit
shopt -u inherit_errexit
shopt -s interactive_comments
shopt -u lastpipe
shopt -u lithist
shopt -u localvar_inherit
shopt -u localvar_unset
shopt -s login_shell
shopt -u mailwarn
shopt -u no_empty_cmd_completion
shopt -u nocaseglob
shopt -u nocasematch
shopt -u noexpand_translation
shopt -u nullglob
shopt -s patsub_replacement
shopt -s progcomp
shopt -u progcomp_alias
shopt -s promptvars
shopt -u restricted_shell
shopt -u shift_verbose
shopt -s sourcepath
shopt -u varredir_close
shopt -u xpg_echo
# Functions
gawklibpath_append () 
{ 
    [ -z "$AWKLIBPATH" ] && AWKLIBPATH=`gawk 'BEGIN {print ENVIRON["AWKLIBPATH"]}'`;
    export AWKLIBPATH="$AWKLIBPATH:$*"
}
gawklibpath_default () 
{ 
    unset AWKLIBPATH;
    export AWKLIBPATH=`gawk 'BEGIN {print ENVIRON["AWKLIBPATH"]}'`
}
gawklibpath_prepend () 
{ 
    [ -z "$AWKLIBPATH" ] && AWKLIBPATH=`gawk 'BEGIN {print ENVIRON["AWKLIBPATH"]}'`;
    export AWKLIBPATH="$*:$AWKLIBPATH"
}
gawkpath_append () 
{ 
    [ -z "$AWKPATH" ] && AWKPATH=`gawk 'BEGIN {print ENVIRON["AWKPATH"]}'`;
    export AWKPATH="$AWKPATH:$*"
}
gawkpath_default () 
{ 
    unset AWKPATH;
    export AWKPATH=`gawk 'BEGIN {print ENVIRON["AWKPATH"]}'`
}
gawkpath_prepend () 
{ 
    [ -z "$AWKPATH" ] && AWKPATH=`gawk 'BEGIN {print ENVIRON["AWKPATH"]}'`;
    export AWKPATH="$*:$AWKPATH"
}

# setopts 3
set -o braceexpand
set -o hashall
set -o interactive-comments

# aliases 0

# exports (native declarations)
declare -x BUZZ_AGENT_BIN="/home/alan/.local/bin/codex-acp"
declare -x BUZZ_DEV_MCP_BIN="/home/alan/.local/lib/beeline/bin/buzz-dev-mcp"
declare -x CARGO_TARGET_DIR="/home/alan/.local/state/beeline/cargo-target"
declare -x CLAUDE_CONFIG_DIR="/home/alan/.local/state/beeline/agents/99b179219351bef5006bed6c221fd7832ebdddde3a8c7fd9e782efe918a9aad3/rooms/045510c4-9fc5-43fa-a26d-3156707ca867/scratch/agent-home/claude"
declare -x CODEX_HOME="/home/alan/.local/state/beeline/agents/99b179219351bef5006bed6c221fd7832ebdddde3a8c7fd9e782efe918a9aad3/rooms/045510c4-9fc5-43fa-a26d-3156707ca867/scratch/agent-home/codex"
declare -x CODEX_MANAGED_BY_NPM="1"
declare -x CODEX_MANAGED_PACKAGE_ROOT="/home/alan/.local/lib/node_modules/@agentclientprotocol/codex-acp/node_modules/@openai/codex"
declare -x CURSOR_HOME="/home/alan/.local/state/beeline/agents/99b179219351bef5006bed6c221fd7832ebdddde3a8c7fd9e782efe918a9aad3/rooms/045510c4-9fc5-43fa-a26d-3156707ca867/scratch/agent-home/cursor"
declare -x DEBUGINFOD_URLS="https://debuginfod.ubuntu.com "
declare -x GOOSE_PATH_ROOT="/home/alan/.local/state/beeline/agents/99b179219351bef5006bed6c221fd7832ebdddde3a8c7fd9e782efe918a9aad3/rooms/045510c4-9fc5-43fa-a26d-3156707ca867/scratch/agent-home/goose"
declare -x GROK_HOME="/home/alan/.local/state/beeline/agents/99b179219351bef5006bed6c221fd7832ebdddde3a8c7fd9e782efe918a9aad3/rooms/045510c4-9fc5-43fa-a26d-3156707ca867/scratch/agent-home/grok"
declare -x HOME="/home/alan/.local/state/beeline/agents/99b179219351bef5006bed6c221fd7832ebdddde3a8c7fd9e782efe918a9aad3/rooms/045510c4-9fc5-43fa-a26d-3156707ca867/scratch/agent-home/user"
declare -x LANG="en_US.UTF-8"
declare -x LOGNAME="alan"
declare -x OPENCODE_CONFIG_DIR="/home/alan/.local/state/beeline/agents/99b179219351bef5006bed6c221fd7832ebdddde3a8c7fd9e782efe918a9aad3/rooms/045510c4-9fc5-43fa-a26d-3156707ca867/scratch/agent-home/opencode"
declare -x PATH="/home/alan/.local/state/beeline/agents/99b179219351bef5006bed6c221fd7832ebdddde3a8c7fd9e782efe918a9aad3/rooms/045510c4-9fc5-43fa-a26d-3156707ca867/scratch/agent-home/codex/tmp/arg0/codex-arg0eyLWia:/home/alan/.local/lib/node_modules/@agentclientprotocol/codex-acp/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex-path:/home/alan/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin"
declare -x PI_CODING_AGENT_DIR="/home/alan/.local/state/beeline/agents/99b179219351bef5006bed6c221fd7832ebdddde3a8c7fd9e782efe918a9aad3/rooms/045510c4-9fc5-43fa-a26d-3156707ca867/scratch/agent-home/pi"
declare -x PNPM_CONFIG_STORE_DIR="/home/alan/.local/state/beeline/pnpm-store"
declare -x RUST_LOG="warn"
declare -x SHELL="/bin/bash"
declare -x SHLVL="1"
declare -x SSH_AUTH_SOCK="/run/user/1006/openssh_agent"
declare -x TMPDIR="/home/alan/.local/state/beeline/agents/99b179219351bef5006bed6c221fd7832ebdddde3a8c7fd9e782efe918a9aad3/rooms/045510c4-9fc5-43fa-a26d-3156707ca867/scratch/agent-home/tmp"
declare -x USER="alan"
declare -x XDG_CACHE_HOME="/home/alan/.local/state/beeline/agents/99b179219351bef5006bed6c221fd7832ebdddde3a8c7fd9e782efe918a9aad3/rooms/045510c4-9fc5-43fa-a26d-3156707ca867/scratch/agent-home/cache"
declare -x XDG_CONFIG_HOME="/home/alan/.local/state/beeline/agents/99b179219351bef5006bed6c221fd7832ebdddde3a8c7fd9e782efe918a9aad3/rooms/045510c4-9fc5-43fa-a26d-3156707ca867/scratch/agent-home/user/.config"
declare -x XDG_DATA_DIRS="/usr/local/share:/usr/share:/var/lib/snapd/desktop"
declare -x XDG_DATA_HOME="/home/alan/.local/state/beeline/agents/99b179219351bef5006bed6c221fd7832ebdddde3a8c7fd9e782efe918a9aad3/rooms/045510c4-9fc5-43fa-a26d-3156707ca867/scratch/agent-home/user/.local/share"
declare -x XDG_RUNTIME_DIR="/run/user/1006"
declare -x XDG_STATE_HOME="/home/alan/.local/state/beeline/agents/99b179219351bef5006bed6c221fd7832ebdddde3a8c7fd9e782efe918a9aad3/rooms/045510c4-9fc5-43fa-a26d-3156707ca867/scratch/agent-home/state"
declare -x npm_config_cache="/home/alan/.local/state/beeline/npm-cache"
