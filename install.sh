#!/usr/bin/env bash
#
# Orbit Installer
#
# One-line install:
#   curl -fsSL https://raw.githubusercontent.com/galaxyproject/orbit/main/install.sh | bash
#

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

echo ""
echo -e "${GREEN}╔════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║     Orbit Installer                        ║${NC}"
echo -e "${GREEN}║     Galaxy Co-Scientist for Bioinformatics ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════╝${NC}"
echo ""

# Check Node.js (>=22.19, matching package.json engines.node / .nvmrc)
if ! command -v node &> /dev/null; then
    error "Node.js is required but not installed. Please install Node.js 22.19+ from https://nodejs.org/"
fi

NODE_MAJOR=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
NODE_MINOR=$(node -v | cut -d'.' -f2)
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 19 ]; }; then
    error "Node.js 22.19+ is required. You have $(node -v). Please upgrade."
fi
success "Node.js $(node -v) found"

# Check for uv or python3 (galaxy-mcp needs it)
if command -v uvx &> /dev/null; then
    success "uvx found (for galaxy-mcp)"
elif command -v uv &> /dev/null; then
    success "uv found (for galaxy-mcp)"
elif command -v python3 &> /dev/null; then
    warn "uv not found — galaxy-mcp will use python3 directly"
    warn "For best results, install uv: curl -LsSf https://astral.sh/uv/install.sh | sh"
else
    warn "Neither uv nor python3 found. galaxy-mcp may need manual setup."
fi

# Install the Orbit CLI
info "Installing the Orbit CLI..."
npm install -g @galaxyproject/orbit
success "orbit installed"

echo ""
echo -e "${GREEN}Installation complete!${NC}"
echo ""
echo "Run 'orbit' to start. Use /connect to set your Galaxy credentials."
echo ""
