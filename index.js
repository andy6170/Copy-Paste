(function () {
  const pluginId = "bf-portal-copy-paste-plugin";
  const plugin = BF2042Portal.Plugins.getPlugin(pluginId);

  /* -----------------------------------------------------
     MOUSE POSITION TRACKING — Paste at cursor
  ----------------------------------------------------- */
  let lastMouse = { x: 0, y: 0 };

  function attachMouseTracking(ws) {
    const svg = ws.getParentSvg();
    svg.addEventListener("mousemove", (e) => {
      lastMouse.x = e.clientX;
      lastMouse.y = e.clientY;
    });
  }

  function screenToWorkspace(ws, x, y) {
    const rect = ws.getParentSvg().getBoundingClientRect();
    const metrics = ws.getMetrics();
    return {
      x: (x - rect.left + metrics.viewLeft) / ws.scale,
      y: (y - rect.top + metrics.viewTop) / ws.scale
    };
  }

  /* -----------------------------------------------------
     VARIABLE MANAGEMENT — Auto-create missing variables
  ----------------------------------------------------- */
  function ensureVariableExists(ws, name, type) {
    const varMap = ws.getVariableMap();
    const existing = varMap.getVariable(name);

    if (!existing) {
      return varMap.createVariable(name, type || "", undefined);
    }

    if (existing.type !== type) {
      let suffix = 1;
      let newName = name + "_Copy";
      while (varMap.getVariable(newName)) {
        suffix++;
        newName = name + "_Copy" + suffix;
      }
      return varMap.createVariable(newName, type || "", undefined);
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
     - Converts VAR objects → string
     - Auto-creates missing variables
     - Ensures dropdowns have valid options
     - Preserves subroutine parameters
  ----------------------------------------------------- */
  function sanitizeForWorkspace(ws, root) {
    traverseSerializedBlocks(root, (b) => {
      // --- Preserve subroutineArgumentBlock ARGUMENT_INDEX
      if (b.type === "subroutineArgumentBlock") {
        const argIndex = b.fields?.ARGUMENT_INDEX;
        if (argIndex != null && b.inputs) {
          traverseSerializedBlocks(b.inputs, (child) => {
            if (child.fields && child.fields.VAR) {
              let varName = child.fields.VAR;
              if (typeof varName === "object" && varName.name) varName = varName.name;
              ensureVariableExists(ws, varName, child.fields.VAR?.type || "");
              child.fields.VAR = varName;
            }
          });
        }
        return; // skip further modification for argument blocks
      }

      // --- Normalize VAR fields and auto-create variables
      if (b.fields) {
        for (const [key, val] of Object.entries(b.fields)) {
          const u = key.toUpperCase();
          if (u === "VAR" || u === "VARIABLE" || u.startsWith("VAR")) {
            let varName = val;
            if (val && typeof val === "object" && val.name) varName = val.name;
            const varType = val && val.type ? val.type : "";
            ensureVariableExists(ws, varName, varType);
            b.fields[key] = varName;
          }
        }
      }

      // --- Sanitize dropdowns with missing options
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
     PASTE BLOCK AT CURSOR
  ----------------------------------------------------- */
  async function pasteBlockFromClipboard() {
    try {
      const ws = _Blockly.getMainWorkspace();
      const json = await navigator.clipboard.readText();
      if (!json) return;

      let data = JSON.parse(json);
      data = sanitizeForWorkspace(ws, data);

      const pos = screenToWorkspace(ws, lastMouse.x, lastMouse.y);
      data.x = pos.x;
      data.y = pos.y;

      _Blockly.serialization.blocks.append(data, ws);
      console.info("[CopyPastePlugin] Paste complete at cursor.");
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
