(function () {
  const pluginId = "bf-portal-copy-paste-plugin";
  const plugin = BF2042Portal.Plugins.getPlugin(pluginId);

  /* -----------------------------------------------------
     MOUSE POSITION TRACKING — Paste at cursor
  ----------------------------------------------------- */
  let lastMouseEvent = null;

  function attachMouseTracking(ws) {
    const svg = ws.getParentSvg();
    svg.addEventListener("mousemove", (e) => {
      lastMouseEvent = e;
    });
  }

  function getMouseWorkspacePosition(ws) {
    if (!lastMouseEvent) {
      // fallback: center of workspace
      const metrics = ws.getMetrics();
      return {
        x: metrics.viewLeft + metrics.viewWidth / 2,
        y: metrics.viewTop + metrics.viewHeight / 2,
      };
    }

    const svg = ws.getParentSvg();
    const rect = svg.getBoundingClientRect();

    // Mouse relative to the SVG
    const relativeX = lastMouseEvent.clientX - rect.left;
    const relativeY = lastMouseEvent.clientY - rect.top;

    // Workspace pan/scroll and zoom
    const scrollX = ws.scrollX || 0;
    const scrollY = ws.scrollY || 0;
    const scale = ws.scale || 1;

    // Convert mouse position to workspace coordinates
    const x = relativeX / scale + scrollX;
    const y = relativeY / scale + scrollY;

    return { x, y };
  }

  /* -----------------------------------------------------
     VARIABLE MANAGEMENT — Only create missing variables
  ----------------------------------------------------- */
  function ensureVariableExists(ws, name, type) {
    const varMap = ws.getVariableMap();
    const existing = varMap.getVariable(name);

    if (!existing) {
      return varMap.createVariable(name, type || "", undefined);
    }

    return existing;
  }

  /* -----------------------------------------------------
     TRAVERSE BLOCK TREE
  ----------------------------------------------------- */
  function traverseSerializedBlocks(node, cb) {
    if (!node) return;
    cb(node);
    if (node.inputs) {
      for (const input of Object.values(node.inputs)) {
        if (input.block) traverseSerializedBlocks(input.block, cb);
        if (input.shadow) traverseSerializedBlocks(input.shadow, cb);
      }
    }
    if (node.next && node.next.block) {
      traverseSerializedBlocks(node.next.block, cb);
    }
  }

  /* -----------------------------------------------------
     SANITIZE BLOCKS FOR PASTE
  ----------------------------------------------------- */
  function sanitizeForWorkspace(ws, root) {
    traverseSerializedBlocks(root, (b) => {
      // --- Subroutine argument blocks
      if (b.type === "subroutineArgumentBlock") {
        const argIndex = b.fields?.ARGUMENT_INDEX;
        if (argIndex != null && b.inputs) {
          traverseSerializedBlocks(b.inputs, (child) => {
            if (child.fields && child.fields.VAR) {
              let varName = child.fields.VAR;
              if (typeof varName === "object" && varName.name) varName = varName.name;
              ensureVariableExists(ws, varName, child.fields.VAR?.type || "");
            }
          });
        }
        return;
      }

      // --- General variable fields
      if (b.fields) {
        for (const [key, val] of Object.entries(b.fields)) {
          const u = key.toUpperCase();
          if (u === "VAR" || u === "VARIABLE" || u.startsWith("VAR")) {
            let varName = val;
            if (val && typeof val === "object" && val.name) varName = val.name;
            ensureVariableExists(ws, varName, val?.type || "");
          }
        }
      }

      // --- Sanitize dropdowns
      if (b.fields) {
        for (const [key, val] of Object.entries(b.fields)) {
          if (typeof val !== "string") continue;
          try {
            const blockType = b.type;
            const block = ws.newBlock(blockType);
            const field = block.getField(key);
            if (field && field.getOptions) {
              const opts = field.getOptions();
              const valid = opts.map((o) => o[1]);
              if (!valid.includes(val)) b.fields[key] = valid[0] || "";
            }
            block.dispose(false);
          } catch (e) {}
        }
      }
    });

    return root;
  }

  /* -----------------------------------------------------
     COPY BLOCK — Keep everything except .next
  ----------------------------------------------------- */
  function extractBlockForClipboard(block) {
    const full = _Blockly.serialization.blocks.save(block);
    if (full.next) delete full.next;
    return full;
  }

  async function copyBlockToClipboard(block) {
    try {
      const minimal = extractBlockForClipboard(block);
      await navigator.clipboard.writeText(JSON.stringify(minimal, null, 2));
      console.info("[CopyPastePlugin] Copied block (excluding chain below).");
    } catch (err) {
      console.error("[CopyPastePlugin] Copy failed:", err);
    }
  }

  /* -----------------------------------------------------
     PASTE BLOCK AT CURSOR (preserve relative layout)
  ----------------------------------------------------- */
  async function pasteBlockFromClipboard() {
    try {
      const ws = _Blockly.getMainWorkspace();
      const json = await navigator.clipboard.readText();
      if (!json) return;

      let data = JSON.parse(json);
      data = sanitizeForWorkspace(ws, data);

      const originalX = data.x || 0;
      const originalY = data.y || 0;

      const mousePos = getMouseWorkspacePosition(ws);

      const dx = mousePos.x - originalX;
      const dy = mousePos.y - originalY;

      traverseSerializedBlocks(data, (b) => {
        b.x = (b.x || 0) + dx;
        b.y = (b.y || 0) + dy;
      });

      _Blockly.serialization.blocks.append(data, ws);
      console.info("[CopyPastePlugin] Paste complete at cursor with relative positions preserved.");
    } catch (err) {
      console.error("[CopyPastePlugin] Paste failed:", err);
    }
  }

  /* -----------------------------------------------------
     CONTEXT MENU ITEMS
  ----------------------------------------------------- */
  const copyItem = {
    id: "copyBlockMenuItem",
    displayText: "Copy - BF6",
    preconditionFn: () => "enabled",
    callback: (scope) => {
      if (scope.block) copyBlockToClipboard(scope.block);
    },
    scopeType: _Blockly.ContextMenuRegistry.ScopeType.BLOCK,
    weight: 90
  };

  const pasteItem = {
    id: "pasteBlockMenuItem",
    displayText: "Paste - BF6",
    preconditionFn: () => "enabled",
    callback: () => pasteBlockFromClipboard(),
    scopeType: _Blockly.ContextMenuRegistry.ScopeType.WORKSPACE,
    weight: 90
  };

  /* -----------------------------------------------------
     INITIALIZATION
  ----------------------------------------------------- */
  plugin.initializeWorkspace = function () {
    try {
      const ws = _Blockly.getMainWorkspace();
      const reg = _Blockly.ContextMenuRegistry.registry;

      if (reg.getItem(copyItem.id)) reg.unregister(copyItem.id);
      if (reg.getItem(pasteItem.id)) reg.unregister(pasteItem.id);

      reg.register(copyItem);
      reg.register(pasteItem);

      attachMouseTracking(ws);

      console.info("[CopyPastePlugin] Initialized successfully.");
    } catch (err) {
      console.error("[CopyPastePlugin] Initialization failed:", err);
    }
  };
})();
