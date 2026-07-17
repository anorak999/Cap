#!/bin/bash
#
# Cap — install script.
# Compiles the GSettings schema, links the extension into the per-user GNOME
# Shell extensions directory, and enables it. A shell restart is required to
# load the extension (X11: Alt+F2 → r; Wayland: log out and back in).

set -e

EXTENSION_UUID="cap@anorak"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_DIR="$HOME/.local/share/gnome-shell/extensions/$EXTENSION_UUID"

echo "--------------------------------------------------"
echo "Installing Cap"
echo "--------------------------------------------------"

echo "Compiling GSettings schema..."
glib-compile-schemas "$SCRIPT_DIR/schemas"

echo "Linking extension into $EXTENSION_DIR ..."
if [ -e "$EXTENSION_DIR" ] && [ ! -L "$EXTENSION_DIR" ]; then
    echo "  A real (non-symlink) directory already exists there."
    echo "  Backing it up to ${EXTENSION_DIR}.bak and replacing it."
    mv "$EXTENSION_DIR" "${EXTENSION_DIR}.bak"
fi
ln -sfn "$SCRIPT_DIR" "$EXTENSION_DIR"

echo "Enabling the extension..."
gnome-extensions enable "$EXTENSION_UUID" 2>/dev/null || true

echo "--------------------------------------------------"
echo "Installation complete!"
echo "--------------------------------------------------"
echo "To load Cap, restart GNOME Shell:"
echo "  Wayland: log out and back in"
echo "  X11:     Alt+F2  →  r  →  Enter"
echo ""
echo "Once loaded, the Cap indicator (↓ rate ↑ rate) appears in the top bar."
