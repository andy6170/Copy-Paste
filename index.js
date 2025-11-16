(function () {
  const pluginId = "bf-portal-copy-paste-plugin";
  const plugin = BF2042Portal.Plugins.getPlugin(pluginId);

  /* -----------------------------------------------------
     MOUSE POSITION TRACKING — Fixes offset paste location
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
     VARIABLE MANAGEMENT — Create “missing” variables
  ----------------------------------------------------- */

  function ensureVariableExists(ws, name, type) {
    const varMap = ws.getVariableMap();
    const existing = varMap.getVariable(name);

    if (!existing) {
      return varMap.createVariable(name, type || "", undefined);
    }

    // Name exists but wrong type → append _Copy until safe
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
     SANITIZE SERIALIZED TREE BEFORE PASTING
     Fixes the “FieldDropdown options must not be an empty array”
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

  function sanitizeForWorkspace(ws, root) {
    traverseSerializedBlocks(root, (b) => {
      /* Normalize VAR fields — convert object → string */
      if (b.fields) {
        for (const [key, val] of Object.entries(b.fields)) {
          const u = key.toUpperCase();

          if (u === "VAR" || u === "VARIABLE" || u.startsWith("VAR")) {
            if (val && typeof val === "object" && val.name) {
              b.fields[key] = val.name;
            }
            if (typeof b.fields[key] === "string") {
              ensureVariableExists(ws, b.fields[key], b.fields.type || "");
            }
          }
        }
      }

      /* Sanitize dropdowns with missing options */
      if (b.fields) {
        for (const [key, val] of Object.entries(b.fields)) {
          if (typeof val !== "string") continue;

          const blockType = b.type;
          const block = ws.newBlock(blockType);
          const field = block.getField(key);

          if (field && field.getOptions) {
            const opts = field.getOptions();
            const valid = opts.map((o) => o[1]);
            if (!valid.includes(val)) {
              b.fields[key] = valid[0] || "";
            }
          }

          block.dispose(false);
        }
      }
    });

    return root;
  }

  /* -----------------------------------------------------
     COPY ONLY internal inputs (NOT the block chain)
  ----------------------------------------------------- */

  function extractInnerContents(block) {
    const saved = {
      type: block.type,
      inputs: {}
    };

    const realBlockJSON = _Blockly.serialization.blocks.save(block);

    for (const [inputName, inputData] of Object.entries(realBlockJSON.inputs || {})) {
      // Keep only inputs that contain child blocks (not the next connection)
      if (inputData.block) {
        saved.inputs[inputName] = { block: inputData.block };
      } else if (inputData.shadow) {
        saved.inputs[inputName] = { shadow: inputData.shadow };
      }
    }

    return saved;
  }

  /* -----------------------------------------------------
     COPY TO CLIPBOARD
  ----------------------------------------------------- */

  async function copyBlockToClipboard(block) {
    try {
      const minimal = extractInnerContents(block);
      await navigator.clipboard.writeText(JSON.stringify(minimal, null, 2));
      console.info("[CopyPastePlugin] Copied clean inner contents.");
    } catch (err) {
      console.error("[CopyPastePlugin] Copy failed:", err);
    }
  }

  /* -----------------------------------------------------
     PASTE FROM CLIPBOARD — With full sanitation
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

      console.info("[CopyPastePlugin] Paste complete.");
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

      console.info("[CopyPastePlugin] Initialized.");
    } catch (err) {
      console.error("[CopyPastePlugin] Initialization failed:", err);
    }
  };
})();
