(function () {
  const pluginId = "bf-portal-copy-paste-plugin";
  const plugin = BF2042Portal.Plugins.getPlugin(pluginId);

  let lastMouse = { x: 100, y: 100 }; // fallback defaults

  /**
   * Tracks mouse position over workspace SVG.
   */
  function attachMouseTracking(ws) {
    const svg = ws.getParentSvg();

    svg.addEventListener("mousemove", (e) => {
      lastMouse.x = e.clientX;
      lastMouse.y = e.clientY;
    });
  }

  /**
   * Convert screen → workspace coordinates (compatible with older Blockly)
   */
  function screenToWorkspace(ws, x, y) {
    const metrics = ws.getMetrics();

    const rect = ws.getParentSvg().getBoundingClientRect();

    const wsX = (x - rect.left + metrics.viewLeft) / ws.scale;
    const wsY = (y - rect.top + metrics.viewTop) / ws.scale;

    return { x: wsX, y: wsY };
  }

  /**
   * Copy block to clipboard
   */
  async function copyBlockToClipboard(block) {
    try {
      const data = _Blockly.serialization.blocks.save(block, {
        addCoordinates: false
      });

      const json = JSON.stringify(data, null, 2);

      await navigator.clipboard.writeText(json);

      console.info("[CopyPastePlugin] Copied block to clipboard.");
    } catch (err) {
      console.error("[CopyPastePlugin] Copy failed:", err);
    }
  }

  /**
   * Paste block from clipboard at cursor
   */
  async function pasteBlockFromClipboard() {
    try {
      const ws = _Blockly.getMainWorkspace();

      const text = await navigator.clipboard.readText();
      if (!text) {
        console.warn("[CopyPastePlugin] Clipboard empty.");
        return;
      }

      let blockData = JSON.parse(text);

      // Convert cursor → workspace coords
      const pos = screenToWorkspace(ws, lastMouse.x, lastMouse.y);

      blockData.x = pos.x;
      blockData.y = pos.y;

      _Blockly.serialization.blocks.append(blockData, ws);

      console.info("[CopyPastePlugin] Block pasted at cursor.");
    } catch (err) {
      console.error("[CopyPastePlugin] Paste failed:", err);
    }
  }

  // ----- Context menu items -----

  const copyBlockMenuItem = {
    id: "copyBlockMenuItem",
    displayText: "Copy - BF6",
    preconditionFn: () => "enabled",
    callback: (scope) => {
      if (scope.block) copyBlockToClipboard(scope.block);
    },
    scopeType: _Blockly.ContextMenuRegistry.ScopeType.BLOCK,
    weight: 90
  };

  const pasteBlockMenuItem = {
    id: "pasteBlockMenuItem",
    displayText: "Paste - BF6",
    preconditionFn: () => "enabled",
    callback: () => pasteBlockFromClipboard(),
    scopeType: _Blockly.ContextMenuRegistry.ScopeType.WORKSPACE,
    weight: 90
  };

  plugin.initializeWorkspace = function () {
    console.info("[CopyPastePlugin] Initializing…");

    try {
      const ws = _Blockly.getMainWorkspace();
      const registry = _Blockly.ContextMenuRegistry.registry;

      // Remove existing menu items if plugin reloads
      if (registry.getItem(copyBlockMenuItem.id))
        registry.unregister(copyBlockMenuItem.id);
      if (registry.getItem(pasteBlockMenuItem.id))
        registry.unregister(pasteBlockMenuItem.id);

      registry.register(copyBlockMenuItem);
      registry.register(pasteBlockMenuItem);

      attachMouseTracking(ws);

      console.info("[CopyPastePlugin] Ready.");
    } catch (err) {
      console.error("[CopyPastePlugin] Initialization error:", err);
    }
  };
})();
