#!/bin/bash
#
# Cap — uninstall script.
# Disables the extension and removes it from the per-user GNOME Shell
# extensions directory. Does not touch the source tree this script lives in.

EXTENSION_UUID="cap@anorak"
EXTENSION_DIR="$HOME/.local/share/gnome-shell/extensions/$EXTENSION_UUID"

echo "--------------------------------------------------"
echo "Uninstalling Cap"
echo "--------------------------------------------------"

echo "Disabling the extension..."
gnome-extensions disable "$EXTENSION_UUID" 2>/dev/null || true

echo "Removing extension link/directory..."
if [ -e "$EXTENSION_DIR" ] || [ -L "$EXTENSION_DIR" ]; then
    rm -rf "$EXTENSION_DIR"
else
    echo "  Nothing to remove at $EXTENSION_DIR"
fi

echo "--------------------------------------------------"
echo "Uninstallation complete!"
echo "--------------------------------------------------"
echo "Restart GNOME Shell to clear the indicator from the top bar:"
echo "  Wayland: log out and back in"
echo "  X11:     Alt+F2  →  r  →  Enter"
