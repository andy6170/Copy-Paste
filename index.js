(function () {
  const pluginId = "bf-portal-copy-paste-plugin";
  const plugin = BF2042Portal.Plugins.getPlugin(pluginId);

  /* -----------------------------------------------------
     Mouse tracking: we store the last MouseEvent (not just coords)
     so we can convert it through the SVG CTM for exact mapping.
  ----------------------------------------------------- */
  let lastMouseEvent = null;

  function attachMouseTracking(ws) {
    try {
      const svg = ws.getParentSvg();
      if (!svg || svg._copyPasteTrackingAttached) return;
      svg._copyPasteTrackingAttached = true;
      svg.addEventListener("mousemove", (e) => {
        lastMouseEvent = e;
      }, { passive: true });
    } catch (e) {
      console.warn("[CopyPastePlugin] attachMouseTracking failed:", e);
    }
  }

  /* -----------------------------------------------------
     Convert the last mouse event to workspace coordinates
     Primary method: use the actual block canvas CTM -> inverse transform.
     Fallback: use metrics + scale if CTM is not available.
  ----------------------------------------------------- */
  function getMouseWorkspacePosition(ws) {
    try {
      // fallback center if no mouse event
      if (!lastMouseEvent) {
        const metrics = ws.getMetrics();
        return {
          x: (metrics.viewLeft || 0) + (metrics.viewWidth || 0) / 2,
          y: (metrics.viewTop || 0) + (metrics.viewHeight || 0) / 2
        };
      }

      // Prefer workspace.getCanvas() if available (standard Blockly)
      let canvas = null;
      try {
        if (typeof ws.getCanvas === "function") canvas = ws.getCanvas();
      } catch (e) {
        canvas = null;
      }

      // Portal-specific fallback: query the transform group we observed
      if (!canvas) {
        canvas = document.querySelector(".blocklyBlockCanvas");
      }

      // If we have a canvas and an ownerSVGElement, use CTM inverse
      if (canvas && canvas.ownerSVGElement && typeof canvas.getScreenCTM === "function") {
        const svg = canvas.ownerSVGElement;
        // Build an SVGPoint at client coords
        const pt = svg.createSVGPoint();
        pt.x = lastMouseEvent.clientX;
        pt.y = lastMouseEvent.clientY;

        // get the screen CTM for the canvas and invert it
        const ctm = canvas.getScreenCTM();
        if (ctm && typeof ctm.inverse === "function") {
          const inv = ctm.inverse();
          const transformed = pt.matrixTransform(inv);

          // transformed.x / y are in canvas local coordinates — which correspond to workspace coords
          return { x: transformed.x, y: transformed.y };
        }
      }

      // Fallback method (best-effort): use workspace metrics + svg bounding rect + scale
      {
        const svg = ws.getParentSvg();
        const rect = svg.getBoundingClientRect();
        const relativeX = lastMouseEvent.clientX - rect.left;
        const relativeY = lastMouseEvent.clientY - rect.top;
        const metrics = ws.getMetrics();
        const scale = ws.scale || 1;
        const scrollX = (metrics.viewLeft !== undefined) ? metrics.viewLeft : (ws.scrollX || 0);
        const scrollY = (metrics.viewTop !== undefined) ? metrics.viewTop : (ws.scrollY || 0);

        const x = scrollX + relativeX / scale;
        const y = scrollY + relativeY / scale;
        return { x, y };
      }
    } catch (err) {
      console.warn("[CopyPastePlugin] getMouseWorkspacePosition fallback used:", err);
      try {
        const metrics = ws.getMetrics();
        return {
          x: (metrics.viewLeft || 0) + (metrics.viewWidth || 0) / 2,
          y: (metrics.viewTop || 0) + (metrics.viewHeight || 0) / 2
        };
      } catch (e) {
        return { x: 0, y: 0 };
      }
    }
  }

  /* -----------------------------------------------------
     VARIABLES: only create missing ones (do not overwrite existing references)
  ----------------------------------------------------- */
  function ensureVariableExists(ws, name, type) {
    try {
      const varMap = ws.getVariableMap();
      if (!varMap) return null;

      // many Blockly variants provide getVariable/getVariableByName behavior
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
        // create variable with the requested name and return it
        if (typeof varMap.createVariable === "function") {
          return varMap.createVariable(name, type || "", undefined);
        }
        // Other variants: workspace.createVariable
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

  /* -----------------------------------------------------
     Traverse serialized block JSON tree
  ----------------------------------------------------- */
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

  /* -----------------------------------------------------
     Sanitization before paste:
     - Ensure variable names exist (create only if missing)
     - Normalize VAR objects into name strings where safe
     - Preserve subroutineArgumentBlock ARGUMENT_INDEX and do not overwrite VAR references
     - Try to ensure dropdown fields have a valid option (best-effort)
  ----------------------------------------------------- */
  function sanitizeForWorkspace(ws, root) {
    traverseSerializedBlocks(root, (b) => {
      // Subroutine argument blocks: ensure referenced variable(s) exist but do not overwrite indices/fields
      if (b.type === "subroutineArgumentBlock") {
        const argIndex = b.fields?.ARGUMENT_INDEX;
        if (argIndex != null && b.inputs) {
          traverseSerializedBlocks(b.inputs, (child) => {
            if (child.fields && child.fields.VAR) {
              // VAR may be object or string — extract name
              let varName = child.fields.VAR;
              if (varName && typeof varName === "object" && varName.name) varName = varName.name;
              if (typeof varName === "string" && varName.length > 0) {
                ensureVariableExists(ws, varName, child.fields.VAR?.type || "");
                // keep child's VAR field as-is (do not overwrite)
              }
            }
          });
        }
        return; // skip other sanitization for argument blocks
      }

      // General variable-like fields (VAR / VARIABLE / VAR...)
      if (b.fields) {
        for (const [key, val] of Object.entries(b.fields)) {
          const ku = key.toUpperCase();
          if (ku === "VAR" || ku === "VARIABLE" || ku.startsWith("VAR")) {
            let varName = val;
            if (val && typeof val === "object" && val.name) varName = val.name;
            if (typeof varName === "string" && varName.length > 0) {
              ensureVariableExists(ws, varName, val?.type || "");
              // do NOT overwrite the original field (some blocks expect object form)
              // but convert object form to plain string name if it won't break things:
              if (val && typeof val === "object" && val.name) {
                b.fields[key] = varName;
              }
            }
          }
        }
      }

      // Sanitize dropdown fields (best-effort): create a temporary block of same type to query field options
      if (b.fields) {
        for (const [key, val] of Object.entries(b.fields)) {
          if (typeof val !== "string") continue;
          try {
            const blockType = b.type;
            const temp = ws.newBlock(blockType);
            const field = temp.getField(key);
            if (field && typeof field.getOptions === "function") {
              const opts = field.getOptions();
              const valid = opts.map((o) => o[1]);
              if (!valid.includes(val)) {
                b.fields[key] = valid[0] || "";
              }
            }
            temp.dispose(false);
          } catch (e) {
            // ignore; this is best-effort sanitization
          }
        }
      }
    });

    return root;
  }

  /* -----------------------------------------------------
     Copy routine: serialize the block and remove top-level next chain
  ----------------------------------------------------- */
  function extractBlockForClipboard(block) {
    try {
      const full = _Blockly.serialization.blocks.save(block);
      if (full.next) delete full.next;
      return full;
    } catch (e) {
      // fallback to XML serialization if necessary
      try {
        const xml = Blockly.Xml.blockToDom(block, /*opt_noId=*/ true);
        return { _legacyXml: Blockly.Xml.domToText(xml) };
      } catch (xmlErr) {
        console.error("[CopyPastePlugin] extractBlockForClipboard failed:", e, xmlErr);
        return null;
      }
    }
  }

  async function copyBlockToClipboard(block) {
    try {
      const minimal = extractBlockForClipboard(block);
      if (!minimal) return;
      await navigator.clipboard.writeText(JSON.stringify(minimal, null, 2));
      console.info("[CopyPastePlugin] Copied block (excluding chain below).");
    } catch (err) {
      console.error("[CopyPastePlugin] Copy failed:", err);
    }
  }

  /* -----------------------------------------------------
     Paste routine:
     - sanitize for workspace (ensure variables, dropdowns)
     - compute original top-left and offset to the mouse workspace position (using CTM inverse)
     - apply offset to all blocks (preserve relative positions)
     - append using Blockly serialization
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
        // maybe legacy XML wrapper
        try {
          const parsed = JSON.parse(json);
          data = parsed;
        } catch (ex) {
          if (typeof json === "string" && json.trim().startsWith("<xml")) {
            // legacy XML: paste directly
            try {
              const xmlDom = Blockly.Xml.textToDom(json);
              // try to paste at mouse: convert mouse to workspace coords and translate xml if possible
              const mousePos = getMouseWorkspacePosition(ws);
              // simplest approach: domToWorkspace will place at default; we won't perfect-transform the xml here
              Blockly.Xml.domToWorkspace(xmlDom, ws);
              console.info("[CopyPastePlugin] Pasted legacy XML.");
              return;
            } catch (xmlErr) {
              console.error("[CopyPastePlugin] Failed to parse legacy XML:", xmlErr);
              return;
            }
          }
          console.error("[CopyPastePlugin] Clipboard does not contain valid JSON or XML.");
          return;
        }
      }

      // Sanitize (ensures variables exist and dropdowns valid)
      data = sanitizeForWorkspace(ws, data);

      // Acquire original top-left from serialized data (if not present, treat as 0,0)
      const originalX = (typeof data.x === "number") ? data.x : (data.blocks && data.blocks[0] && data.blocks[0].x) || 0;
      const originalY = (typeof data.y === "number") ? data.y : (data.blocks && data.blocks[0] && data.blocks[0].y) || 0;

      // Get mouse location in workspace coords via CTM inverse (primary) or fallback
      const mousePos = getMouseWorkspacePosition(ws);

      const dx = mousePos.x - originalX;
      const dy = mousePos.y - originalY;

      // Apply offset to each block in the serialized tree
      traverseSerializedBlocks(data, (b) => {
        b.x = (b.x || 0) + dx;
        b.y = (b.y || 0) + dy;
      });

      // Append using modern Blockly serialization if available
      if (_Blockly && _Blockly.serialization && _Blockly.serialization.blocks && typeof _Blockly.serialization.blocks.append === "function") {
        _Blockly.serialization.blocks.append(data, ws);
      } else {
        // fallback: attempt XML route if possible
        if (data._legacyXml) {
          try {
            const dom = Blockly.Xml.textToDom(data._legacyXml);
            Blockly.Xml.domToWorkspace(dom, ws);
          } catch (xmlErr) {
            console.error("[CopyPastePlugin] Fallback XML paste failed:", xmlErr);
          }
        } else {
          console.error("[CopyPastePlugin] No append method available on this Blockly build.");
        }
      }

      console.info("[CopyPastePlugin] Paste complete at cursor (relative positions preserved).");
    } catch (err) {
      console.error("[CopyPastePlugin] Paste failed:", err);
    }
  }

  /* -----------------------------------------------------
     Context menu items (BF6 labels)
  ----------------------------------------------------- */
  const copyItem = {
    id: "copyBlockMenuItem",
    displayText: "Copy - BF6",
    preconditionFn: () => "enabled",
    callback: (scope) => {
      if (scope && scope.block) copyBlockToClipboard(scope.block);
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
     Initialization
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

      console.info("[CopyPastePlugin] Initialized (CTM-based mouse mapping).");
    } catch (err) {
      console.error("[CopyPastePlugin] Initialization failed:", err);
    }
  };
})();
