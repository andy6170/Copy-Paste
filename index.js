(function () {
  const pluginId = "bf-portal-copy-paste-plugin";
  const plugin = BF2042Portal.Plugins.getPlugin(pluginId);

  let lastMouseEvent = null;

  function attachMouseTracking(ws) {
    try {
      const svg = ws.getParentSvg();
      if (!svg || svg._copyPasteTrackingAttached) return;
      svg._copyPasteTrackingAttached = true;
      svg.addEventListener(
        "mousemove",
        (e) => {
          lastMouseEvent = e;
        },
        { passive: true }
      );
    } catch (e) {
      console.warn("[CopyPastePlugin] attachMouseTracking failed:", e);
    }
  }

  function getMouseWorkspacePosition(ws) {
    try {
      if (!lastMouseEvent) {
        const metrics = ws.getMetrics();
        return {
          x: (metrics.viewLeft || 0) + (metrics.viewWidth || 0) / 2,
          y: (metrics.viewTop || 0) + (metrics.viewHeight || 0) / 2,
        };
      }

      let canvas = null;
      try {
        if (typeof ws.getCanvas === "function") canvas = ws.getCanvas();
      } catch {}
      if (!canvas) canvas = document.querySelector(".blocklyBlockCanvas");

      if (
        canvas &&
        canvas.ownerSVGElement &&
        typeof canvas.getScreenCTM === "function"
      ) {
        const svg = canvas.ownerSVGElement;
        const pt = svg.createSVGPoint();
        pt.x = lastMouseEvent.clientX;
        pt.y = lastMouseEvent.clientY;

        const ctm = canvas.getScreenCTM();
        if (ctm && typeof ctm.inverse === "function") {
          const inv = ctm.inverse();
          const transformed = pt.matrixTransform(inv);
          return { x: transformed.x, y: transformed.y };
        }
      }

      const svg = ws.getParentSvg();
      const rect = svg.getBoundingClientRect();
      const relativeX = lastMouseEvent.clientX - rect.left;
      const relativeY = lastMouseEvent.clientY - rect.top;
      const metrics = ws.getMetrics();
      const scale = ws.scale || 1;
      const scrollX =
        metrics.viewLeft !== undefined ? metrics.viewLeft : ws.scrollX || 0;
      const scrollY =
        metrics.viewTop !== undefined ? metrics.viewTop : ws.scrollY || 0;

      return {
        x: scrollX + relativeX / scale,
        y: scrollY + relativeY / scale,
      };
    } catch {
      const metrics = ws.getMetrics();
      return {
        x: (metrics.viewLeft || 0) + (metrics.viewWidth || 0) / 2,
        y: (metrics.viewTop || 0) + (metrics.viewHeight || 0) / 2,
      };
    }
  }

  /* ---------------------------
     Extract variable definitions from serialized JSON
     Returns array of { id, name, type, isObjectVar (bool) }
  ---------------------------- */
  function extractVariableDefinitions(serializedRoot) {
    const varsById = new Map();
    traverseSerializedBlocks(serializedRoot, (b) => {
      if (b.fields && b.fields.VAR) {
        const raw = b.fields.VAR;
        let id = null,
          name = null,
          type = "";
        if (raw && typeof raw === "object") {
          id = raw.id || null;
          name = raw.name || null;
          type = raw.type || "";
        } else if (typeof raw === "string") {
          // Some serialized forms store only the name
          id = null;
          name = raw;
          type = "";
        }
        // also check extraState.isObjectVar if present
        const isObjectVar = !!(b.extraState && b.extraState.isObjectVar);
        if (name) {
          const key = id || name + "::" + type;
          if (!varsById.has(key)) {
            varsById.set(key, { id: id, name: name, type: type, isObjectVar: isObjectVar });
          }
        }
      }
    });
    return Array.from(varsById.values());
  }

  /* ---------------------------
     Register/create variables in the workspace BEFORE block creation.
     Attempts multiple varMap/workspace APIs and prefers creating variable
     with the original id where possible.
  ---------------------------- */
  function registerVariablesBeforePaste(ws, varDefs) {
    try {
      const varMap = ws.getVariableMap ? ws.getVariableMap() : null;

      for (const v of varDefs) {
        try {
          // Try find existing by id first
          let existing = null;
          if (varMap && typeof varMap.getVariable === "function") {
            // some variants accept id or name; try both defensively
            try {
              existing = varMap.getVariable(v.id);
            } catch (e) {
              existing = null;
            }
          }
          // varMap.getVariableById?
          if (!existing && varMap && typeof varMap.getVariableById === "function") {
            try {
              existing = varMap.getVariableById(v.id);
            } catch (e) {
              existing = null;
            }
          }
          // try by name
          if (!existing && varMap && typeof varMap.getVariableByName === "function") {
            try {
              existing = varMap.getVariableByName(v.name);
            } catch (e) {
              existing = null;
            }
          }
          if (!existing && varMap && typeof varMap.getVariable === "function") {
            // some builds use getVariable(name)
            try {
              existing = varMap.getVariable(v.name);
            } catch (e) {
              existing = null;
            }
          }

          // If a variable with the exact id exists, ensure type matches (do not change)
          if (existing) {
            // If existing type differs and name differs, don't overwrite — preserved workspace variable wins.
            // We only create if missing.
            continue;
          }

          // Create variable using the best API available. Try to keep id when possible.
          let created = null;
          if (varMap && typeof varMap.createVariable === "function") {
            try {
              // createVariable(name, type, id) is supported by some Blockly versions
              created = varMap.createVariable(v.name, v.type || "", v.id);
            } catch (e) {
              try {
                created = varMap.createVariable(v.name, v.type || "", undefined);
              } catch (e2) {
                created = null;
              }
            }
          }
          if (!created && typeof ws.createVariable === "function") {
            try {
              created = ws.createVariable(v.name, v.type || "", v.id);
            } catch (e) {
              try {
                created = ws.createVariable(v.name, v.type || "", undefined);
              } catch (ee) {
                created = null;
              }
            }
          }

          // As a last resort, try Blockly global API if present
          if (!created && typeof Blockly !== "undefined" && typeof Blockly.Variables !== "undefined") {
            try {
              // Some builds provide Blockly.Variables.createVariable
              if (typeof Blockly.Variables.createVariable === "function") {
                created = Blockly.Variables.createVariable(ws, v.name, v.type || "", v.id);
              }
            } catch (e) {
              created = null;
            }
          }
        } catch (inner) {
          // ignore per-variable creation errors
          console.warn("[CopyPastePlugin] registerVariablesBeforePaste error for", v, inner);
        }
      }
    } catch (err) {
      console.warn("[CopyPastePlugin] registerVariablesBeforePaste failed:", err);
    }
  }

  function ensureVariableExists(ws, name, type) {
    try {
      const varMap = ws.getVariableMap();
      if (!varMap) return null;

      let existing = null;
      try {
        existing = varMap.getVariable(name);
      } catch (e) {
        existing = null;
      }
      if (!existing && typeof varMap.getVariableByName === "function") {
        try {
          existing = varMap.getVariableByName(name);
        } catch (e) {
          existing = null;
        }
      }

      if (!existing) {
        if (typeof varMap.createVariable === "function") {
          return varMap.createVariable(name, type || "", undefined);
        }
        if (typeof ws.createVariable === "function") {
          return ws.createVariable(name, type || "", undefined);
        }
      }
      return existing;
    } catch (e) {
      console.warn("[CopyPastePlugin] ensureVariableExists error:", e);
      return null;
    }
  }

  function traverseSerializedBlocks(node, cb) {
    if (!node) return;
    cb(node);
    if (node.inputs && typeof node.inputs === "object") {
      for (const input of Object.values(node.inputs)) {
        if (input && input.block) traverseSerializedBlocks(input.block, cb);
        if (input && input.shadow) traverseSerializedBlocks(input.shadow, cb);
      }
    }
    if (node.next && node.next.block) traverseSerializedBlocks(node.next.block, cb);
  }

  /* Fixed sanitizer: skip variableReferenceBlock and subroutineArgumentBlock */
  function sanitizeForWorkspace(ws, root) {
    traverseSerializedBlocks(root, (b) => {
      if (b.type === "variableReferenceBlock") return;
      if (b.type === "subroutineArgumentBlock") return;

      if (b.fields) {
        for (const [key, val] of Object.entries(b.fields)) {
          const ku = key.toUpperCase();
          if (ku === "VAR" || ku === "VARIABLE" || ku.startsWith("VAR")) {
            let varName = val;
            if (val && typeof val === "object" && val.name) varName = val.name;
            if (typeof varName === "string" && varName.length > 0) {
              ensureVariableExists(ws, varName, val?.type || "");
            }
          }
        }
      }

      if (b.fields) {
        for (const [key, val] of Object.entries(b.fields)) {
          if (typeof val !== "string") continue;
          try {
            const temp = ws.newBlock(b.type);
            const field = temp.getField(key);
            if (field && typeof field.getOptions === "function") {
              const opts = field.getOptions();
              const values = opts.map((o) => o[1]);
              if (!values.includes(val)) b.fields[key] = values[0] || "";
            }
            temp.dispose(false);
          } catch {}
        }
      }
    });

    return root;
  }

  function extractBlockForClipboard(block) {
    try {
      const full = _Blockly.serialization.blocks.save(block);
      if (full.next) delete full.next;
      return full;
    } catch {
      try {
        const xml = Blockly.Xml.blockToDom(block, true);
        return { _legacyXml: Blockly.Xml.domToText(xml) };
      } catch {
        return null;
      }
    }
  }

  async function copyBlockToClipboard(block) {
    try {
      const minimal = extractBlockForClipboard(block);
      if (!minimal) return;
      await navigator.clipboard.writeText(JSON.stringify(minimal, null, 2));
    } catch (err) {
      console.error("[CopyPastePlugin] Copy failed:", err);
    }
  }

  /* -----------------------------------------------------
     PASTE: register variables first, then sanitize (skipping varRef),
     then offset and append.
  ----------------------------------------------------- */
  async function pasteBlockFromClipboard() {
    try {
      const ws = _Blockly.getMainWorkspace();
      if (!ws) {
        console.warn("[CopyPastePlugin] No workspace available.");
        return;
      }

      const json = await navigator.clipboard.readText();
      if (!json) {
        console.warn("[CopyPastePlugin] Clipboard empty.");
        return;
      }

      let data;
      try {
        data = JSON.parse(json);
      } catch (e) {
        console.error("[CopyPastePlugin] Clipboard JSON parse failed:", e);
        return;
      }

      // --- NEW: extract var defs and register them BEFORE any block creation
      const varDefs = extractVariableDefinitions(data);
      if (varDefs.length > 0) {
        registerVariablesBeforePaste(ws, varDefs);
      }

      // --- NEW: Detect and auto-rename subroutine if name already exists ---
function renameSubroutineIfNeeded(ws, data) {
  try {
    if (!data || data.type !== "subroutineBlock") return data;

    const originalName =
      data.extraState?.subroutineName ||
      data.fields?.SUBROUTINE_NAME;

    if (!originalName) return data;

    // Collect existing names
    const existingNames = new Set();

    const allBlocks = ws.getAllBlocks(false);
    for (const b of allBlocks) {
      if (b.type === "subroutineBlock") {
        const name =
          (b.extraState && b.extraState.subroutineName) ||
          (b.getField && b.getField("SUBROUTINE_NAME")?.getValue());
        if (name) existingNames.add(name);
      }
    }

    if (!existingNames.has(originalName)) return data;

    // Generate new unique name
    let i = 1;
    let newName = originalName + i;
    while (existingNames.has(newName)) {
      i++;
      newName = originalName + i;
    }

    // Apply new name to the subroutine
    if (data.extraState) data.extraState.subroutineName = newName;
    if (data.fields) data.fields.SUBROUTINE_NAME = newName;

    // Also rewrite ANY reference to the subroutine name inside inputs
    traverseSerializedBlocks(data, (b) => {
      if (b.fields && b.fields.SUBROUTINE_NAME === originalName) {
        b.fields.SUBROUTINE_NAME = newName;
      }
    });

    return data;
  } catch (err) {
    console.warn("[CopyPastePlugin] renameSubroutineIfNeeded failed:", err);
    return data;
  }
}


      // Then sanitize (this now leaves variableReferenceBlock untouched)
      data = renameSubroutineIfNeeded(ws, data);
      data = sanitizeForWorkspace(ws, data);

      // Compute original top-left and mouse offset
      const originalX = (typeof data.x === "number") ? data.x : (data.blocks && data.blocks[0] && data.blocks[0].x) || 0;
      const originalY = (typeof data.y === "number") ? data.y : (data.blocks && data.blocks[0] && data.blocks[0].y) || 0;

      const mousePos = getMouseWorkspacePosition(ws);
      const dx = mousePos.x - originalX;
      const dy = mousePos.y - originalY;

      traverseSerializedBlocks(data, (b) => {
        b.x = (b.x || 0) + dx;
        b.y = (b.y || 0) + dy;
      });

      if (_Blockly && _Blockly.serialization && _Blockly.serialization.blocks && typeof _Blockly.serialization.blocks.append === "function") {
        _Blockly.serialization.blocks.append(data, ws);
      } else if (data._legacyXml) {
        try {
          const dom = Blockly.Xml.textToDom(data._legacyXml);
          Blockly.Xml.domToWorkspace(dom, ws);
        } catch (xmlErr) {
          console.error("[CopyPastePlugin] Fallback XML paste failed:", xmlErr);
        }
      } else {
        console.error("[CopyPastePlugin] No append method available on this Blockly build.");
      }
    } catch (err) {
      console.error("[CopyPastePlugin] Paste failed:", err);
    }
  }

  const copyItem = {
    id: "copyBlockMenuItem",
    displayText: "Copy - BF6",
    preconditionFn: () => "enabled",
    callback: (scope) => {
      if (scope && scope.block) copyBlockToClipboard(scope.block);
    },
    scopeType: _Blockly.ContextMenuRegistry.ScopeType.BLOCK,
    weight: 90,
  };

  const pasteItem = {
    id: "pasteBlockMenuItem",
    displayText: "Paste - BF6",
    preconditionFn: () => "enabled",
    callback: () => pasteBlockFromClipboard(),
    scopeType: _Blockly.ContextMenuRegistry.ScopeType.WORKSPACE,
    weight: 90,
  };

  plugin.initializeWorkspace = function () {
    try {
      const ws = _Blockly.getMainWorkspace();

      const reg = _Blockly.ContextMenuRegistry.registry;
      if (reg.getItem(copyItem.id)) reg.unregister(copyItem.id);
      if (reg.getItem(pasteItem.id)) reg.unregister(pasteItem.id);

      reg.register(copyItem);
      reg.register(pasteItem);

      attachMouseTracking(ws);
    } catch (err) {
      console.error("[CopyPastePlugin] Initialization failed:", err);
    }
  };
})();
