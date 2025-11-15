(function () {
  const pluginId = "bf-portal-copy-paste-plugin";
  const plugin = BF2042Portal.Plugins.getPlugin(pluginId);

  /**
   * Copy selected block into clipboard (JSON).
   * Includes all child blocks (full subtree).
   */
  async function copyBlockToClipboard(block) {
    try {
      const data = _Blockly.serialization.blocks.save(block, {
        addCoordinates: false
      });

      const json = JSON.stringify(data, null, 2);

      await navigator.clipboard.writeText(json);
      console.info("[CopyPastePlugin] Block copied to clipboard.");
    } catch (err) {
      console.error("[CopyPastePlugin] Copy failed:", err);
    }
  }

  /**
   * Paste block at cursor position.
   * Reads JSON from clipboard → appends block.
   */
  async function pasteBlockFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) {
        console.warn("[CopyPastePlugin] Clipboard empty.");
        return;
      }

      let blockData = JSON.parse(text);

      const ws = _Blockly.getMainWorkspace();

      // Get mouse cursor position in workspace coordinates
      const pointer = ws.getPointerPosition();
      const metrics = ws.getMetrics();

      const x = (pointer.x + metrics.viewLeft) / ws.scale;
      const y = (pointer.y + metrics.viewTop) / ws.scale;

      blockData.x = x;
      blockData.y = y;

      _Blockly.serialization.blocks.append(blockData, ws);

      console.info("[CopyPastePlugin] Block pasted at cursor.");
    } catch (err) {
      console.error("[CopyPastePlugin] Paste failed:", err);
    }
  }

  // --- Context menu items ---

  const copyBlockMenuItem = {
    id: "copyBlockMenuItem",
    displayText: "Copy Block",
    preconditionFn: () => "enabled",
    callback: function (scope) {
      const block = scope.block;
      if (block) {
        copyBlockToClipboard(block);
      }
    },
    scopeType: _Blockly.ContextMenuRegistry.ScopeType.BLOCK,
    weight: 90
  };

  const pasteBlockMenuItem = {
    id: "pasteBlockMenuItem",
    displayText: "Paste Block",
    preconditionFn: () => "enabled",
    callback: function () {
      pasteBlockFromClipboard();
    },
    scopeType: _Blockly.ContextMenuRegistry.ScopeType.WORKSPACE,
    weight: 90
  };

  plugin.initializeWorkspace = function () {
    try {
      const registry = _Blockly.ContextMenuRegistry.registry;

      // Remove old if exists
      if (registry.getItem(copyBlockMenuItem.id)) {
        registry.unregister(copyBlockMenuItem.id);
      }
      if (registry.getItem(pasteBlockMenuItem.id)) {
        registry.unregister(pasteBlockMenuItem.id);
      }

      registry.register(copyBlockMenuItem);
      registry.register(pasteBlockMenuItem);

      console.info("[CopyPastePlugin] Ready.");
    } catch (err) {
      console.error("[CopyPastePlugin] Initialization error:", err);
    }
  };
})();
