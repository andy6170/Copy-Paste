(function () {
  const pluginId = "BF6-copy-paste";
  const plugin = BF2042Portal.Plugins.getPlugin(pluginId);

  function log(msg, data) {
    console.log(`[${pluginId}] ${msg}`, data || "");
  }
  function error(msg, data) {
    console.error(`[${pluginId}] ${msg}`, data || "");
  }

  // Track selection set (multi-select)
  let multiSelect = new Set();
  let shiftHeld = false;

  // Track last mouse position (Blockly workspace coordinates)
  let cursorPos = { x: 0, y: 0 };


  // ---------------------------------------------------------
  // 🔹 Track SHIFT for multiselect
  // ---------------------------------------------------------
  document.addEventListener("keydown", e => {
    if (e.key === "Shift") shiftHeld = true;
  });
  document.addEventListener("keyup", e => {
    if (e.key === "Shift") shiftHeld = false;
  });


  // ---------------------------------------------------------
  // 🔹 Track cursor position via context menu open
  // ---------------------------------------------------------
  function hookContextMenuTracking() {
    const origShow = _Blockly.ContextMenu.show;

    _Blockly.ContextMenu.show = function (evt, menu, rtl) {
      try {
        const ws = _Blockly.getMainWorkspace();
        const svgPoint = _Blockly.utils.svgMath.screenToWsCoordinate(
          ws,
          evt.clientX,
          evt.clientY
        );
        cursorPos = { x: svgPoint.x, y: svgPoint.y };
      } catch (e) {
        console.warn("Cursor tracking failed:", e);
      }

      return origShow.apply(this, arguments);
    };
  }


  // ---------------------------------------------------------
  // 🔹 Workspace change listener for multi-select
  // ---------------------------------------------------------
  function selectionListener(event) {
    if (!event.blockId) return;
    if (event.type !== _Blockly.Events.SELECTED) return;

    const ws = _Blockly.getMainWorkspace();
    const block = ws.getBlockById(event.blockId);
    if (!block) return;

    if (shiftHeld) {
      // Toggle block in/out of selection set
      if (multiSelect.has(block)) {
        multiSelect.delete(block);
        block.setHighlighted(false);
      } else {
        multiSelect.add(block);
        block.setHighlighted(true);
      }
    } else {
      // Clear multi-selection when not holding shift
      multiSelect.forEach(b => b.setHighlighted(false));
      multiSelect.clear();
    }
  }


  // ---------------------------------------------------------
  // 🔹 COPY SELECTED BLOCKS (MULTI)
  // ---------------------------------------------------------
  async function copyBlocks() {
    try {
      if (multiSelect.size === 0) {
        alert("No blocks selected. Hold SHIFT and click blocks to select.");
        return;
      }

      let xml = "";
      multiSelect.forEach(block => {
        const dom = _Blockly.Xml.blockToDomWithXY(block, true);
        _Blockly.Xml.deleteNext(dom);
        xml += _Blockly.Xml.domToText(dom);
      });

      await BF2042Portal.Shared.copyTextToClipboard(xml);
      log("Copied blocks to clipboard.");
    } catch (err) {
      error("Copy failed", err);
      alert("Copy failed!");
    }
  }


  // ---------------------------------------------------------
  // 🔹 PASTE BLOCKS (AT CURSOR POSITION)
  // ---------------------------------------------------------
  async function pasteBlocks() {
    try {
      const ws = _Blockly.getMainWorkspace();
      const text = await BF2042Portal.Shared.pasteTextFromClipboard();

      if (!text || !text.trim().match(/<block/)) {
        alert("Clipboard does not contain valid Blockly block XML.");
        return;
      }

      // Wrap multiple blocks if needed
      let xml = text.trim();
      if (!xml.startsWith("<xml")) {
        xml = `<xml xmlns="https://developers.google.com/blockly/xml">${xml}</xml>`;
      }

      // NEW API
      const dom = Blockly.utils.xml.textToDom(xml);

      // Adjust pasted block positions
      const blocks = dom.querySelectorAll("block");
      blocks.forEach(block => {
        block.setAttribute("x", cursorPos.x);
        block.setAttribute("y", cursorPos.y);
      });

      _Blockly.Xml.domToWorkspace(dom, ws);

      log("Pasted blocks at cursor:", cursorPos);
    } catch (err) {
      error("Paste failed", err);
      alert("Paste failed!");
    }
  }


  // ---------------------------------------------------------
  // 🔹 Register Context Menu Items
  // ---------------------------------------------------------
  const copyItem = {
    id: "copyBlocksEnhanced",
    displayText: "Copy Selected Blocks",
    preconditionFn: () => "enabled",
    callback: copyBlocks,
    scopeType: _Blockly.ContextMenuRegistry.ScopeType.WORKSPACE,
    weight: 90
  };

  const pasteItem = {
    id: "pasteBlocksEnhanced",
    displayText: "Paste Blocks (Here)",
    preconditionFn: () => "enabled",
    callback: pasteBlocks,
    scopeType: _Blockly.ContextMenuRegistry.ScopeType.WORKSPACE,
    weight: 89
  };


  // ---------------------------------------------------------
  // 🔹 Plugin Init
  // ---------------------------------------------------------
  plugin.initializeWorkspace = function () {
    try {
      const ws = _Blockly.getMainWorkspace();
      const registry = _Blockly.ContextMenuRegistry.registry;

      // Register items
      if (registry.getItem(copyItem.id)) registry.unregister(copyItem.id);
      if (registry.getItem(pasteItem.id)) registry.unregister(pasteItem.id);

      registry.register(copyItem);
      registry.register(pasteItem);

      // Upgrade selection logic
      ws.removeChangeListener(selectionListener);
      ws.addChangeListener(selectionListener);

      hookContextMenuTracking();

      log("Copy/Paste Enhanced Plugin Loaded!");
    } catch (e) {
      error("Initialization failed", e);
    }
  };

})();
