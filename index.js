(function () {
  const pluginId = "bf-portal-copy-paste-plugin";
  const plugin = BF2042Portal.Plugins.getPlugin(pluginId);

  // last known mouse position (screen coords)
  let lastMouse = { x: 100, y: 100 };

  /**
   * Attach mouse tracking to workspace SVG so we can paste at cursor across Blockly builds
   */
  function attachMouseTracking(ws) {
    try {
      const svg = ws.getParentSvg();
      if (!svg || svg._copyPasteTrackingAttached) return;
      svg._copyPasteTrackingAttached = true;
      svg.addEventListener("mousemove", (e) => {
        lastMouse.x = e.clientX;
        lastMouse.y = e.clientY;
      });
    } catch (e) {
      console.warn("[CopyPastePlugin] attachMouseTracking failed:", e);
    }
  }

  /**
   * Convert screen -> workspace coords (compatible with old and new Blockly)
   */
  function screenToWorkspace(ws, screenX, screenY) {
    const rect = ws.getParentSvg().getBoundingClientRect();
    const metrics = ws.getMetrics ? ws.getMetrics() : { viewLeft: 0, viewTop: 0 };
    const scale = ws.scale || 1;
    const wsX = (screenX - rect.left + (metrics.viewLeft || 0)) / scale;
    const wsY = (screenY - rect.top + (metrics.viewTop || 0)) / scale;
    return { x: wsX, y: wsY };
  }

  /**
   * Recursively walk the serialized block JSON and call fn(blockJson) for each block object.
   * Handles the structure produced by Blockly.serialization.blocks.save / append.
   */
  function traverseSerializedBlocks(blockJson, fn) {
    if (!blockJson || typeof blockJson !== "object") return;
    // single block
    if (blockJson.type) {
      fn(blockJson);
      // inputs (value / statement)
      if (blockJson.inputs) {
        Object.values(blockJson.inputs).forEach((input) => {
          if (input.block) traverseSerializedBlocks(input.block, fn);
          if (input.shadow) traverseSerializedBlocks(input.shadow, fn);
        });
      }
      // next chain
      if (blockJson.next) {
        if (blockJson.next.block) traverseSerializedBlocks(blockJson.next.block, fn);
      }
    } else if (Array.isArray(blockJson.blocks)) {
      // container: { blocks: [...] }
      blockJson.blocks.forEach((b) => traverseSerializedBlocks(b, fn));
    } else if (Array.isArray(blockJson)) {
      blockJson.forEach((b) => traverseSerializedBlocks(b, fn));
    }
  }

  /**
   * Remove the top-level 'next' for the root block in the serialized payload so we don't copy the following chain.
   * If the clipboard contains multiple top-level blocks (array/object), remove 'next' only for the root block(s) that
   * match the original root id(s).
   */
  function stripRootNexts(serialized) {
    // Cases: object single block, or {blocks: [...]}, or array of blocks
    const removeNextFromBlock = (b) => {
      if (b && b.next) {
        delete b.next;
      }
    };

    if (!serialized) return serialized;
    if (Array.isArray(serialized)) {
      // remove next only from first block(s) that have top-level property "topLevel" or we assume first is root
      if (serialized.length > 0) {
        removeNextFromBlock(serialized[0]);
      }
    } else if (serialized.blocks && Array.isArray(serialized.blocks)) {
      if (serialized.blocks.length > 0) removeNextFromBlock(serialized.blocks[0]);
    } else if (serialized.type) {
      // single block object
      removeNextFromBlock(serialized);
    }
    return serialized;
  }

  /**
   * Collect variable names referenced in serialized blocks.
   * Heuristic: look for fields whose keys commonly are 'VAR', 'VARIABLE', 'VAR1', etc.
   * Also look into mutation or field values that look like variable names.
   */
  function collectVariableNamesFromSerialized(serialized) {
    const vars = new Set();

    traverseSerializedBlocks(serialized, (b) => {
      if (b.fields && typeof b.fields === "object") {
        Object.entries(b.fields).forEach(([fieldName, value]) => {
          if (!value && value !== 0) return;
          // Common field names used for variables in Blockly are 'VAR', 'VARIABLE', 'VAR1', etc.
          const fieldNameUpper = String(fieldName).toUpperCase();
          if (fieldNameUpper.includes("VAR") || fieldNameUpper.includes("VARIABLE")) {
            // if it's a string, assume it's a variable name
            if (typeof value === "string") vars.add(value);
          } else {
            // Heuristic: if the value is a string and matches variable name patterns, include it.
            if (typeof value === "string" && value.length > 0 && /^[A-Za-z0-9_\- ]+$/.test(value)) {
              // We can't be sure — skip adding random strings to avoid false positives.
              // Only add if field name suggests it might be a variable-like field (e.g. ends with 'NAME').
              if (fieldNameUpper.endsWith("NAME")) vars.add(value);
            }
          }
        });
      }
      // Some variable refs may be inside mutation or other properties: check those strings too.
      if (b.mutation && typeof b.mutation === "object") {
        Object.values(b.mutation).forEach((mv) => {
          if (typeof mv === "string" && mv.length && /^[A-Za-z0-9_\- ]+$/.test(mv)) {
            // only include if seems variable-like
            if (mv.length < 60) vars.add(mv);
          }
        });
      }
    });

    return Array.from(vars);
  }

  /**
   * Ensure a variable with name varName exists in workspace. Use naming rule B (exact unless collides -> append _Copy).
   * Returns the final variable object or null on failure.
   */
  function ensureVariableExists(ws, varName) {
    try {
      if (!varName || typeof varName !== "string") return null;
      // Try to get by name; workspace.getVariable may be named getVariable or getVariableById in some builds.
      let existing = null;
      try {
        if (ws.getVariable) existing = ws.getVariable(varName);
      } catch (e) {
        existing = null;
      }

      // Some builds use getVariableByName
      if (!existing && ws.getVariableByName) {
        try {
          existing = ws.getVariableByName(varName);
        } catch (e) {
          existing = null;
        }
      }

      if (existing) return existing;

      // Try to create variable with same name
      let attempt = varName;
      let attemptCount = 0;
      while (attemptCount < 10) {
        try {
          // createVariable(name, type, id) — we'll use only name (type undefined)
          if (ws.createVariable) {
            const v = ws.createVariable(attempt);
            if (v) return v;
          } else if (ws.createVariableByName) {
            const v = ws.createVariableByName(attempt);
            if (v) return v;
          } else {
            // fallback: attempt to add a field to workspace's variable model, if available
            if (ws.variableModel && ws.variableModel.createVariable) {
              const v = ws.variableModel.createVariable({ name: attempt });
              if (v) return v;
            }
          }
        } catch (e) {
          // collision or other issue; append suffix and retry
        }
        attemptCount++;
        attempt = varName + (attemptCount === 1 ? "_Copy" : ("_Copy" + attemptCount));
      }
      console.warn("[CopyPastePlugin] Could not create variable:", varName);
      return null;
    } catch (err) {
      console.error("[CopyPastePlugin] ensureVariableExists error:", err);
      return null;
    }
  }

  /**
   * Before appending serialized block JSON into the workspace:
   * - strip top-level next chain (so we don't copy the following global chain)
   * - ensure variables referenced exist (create them if missing)
   * Returns sanitized serialized data (mutates input).
   */
  function sanitizeSerializedForWorkspace(ws, serialized) {
    // remove top-level next chain from root(s)
    stripRootNexts(serialized);

    // collect variable-like names and create them if needed
    const varNames = collectVariableNamesFromSerialized(serialized);
    varNames.forEach((vn) => {
      try {
        ensureVariableExists(ws, vn);
      } catch (e) {
        console.warn("[CopyPastePlugin] Failed to ensure variable", vn, e);
      }
    });

    // Additional sanitization could be performed here (e.g., remap IDs) if needed.
    return serialized;
  }

  /**
   * copy a block to clipboard — but only the block and its inputs (we will remove the root next chain)
   */
  async function copyBlockToClipboard(block) {
    try {
      // Use Blockly serialization if available
      let data = null;
      if (_Blockly && _Blockly.serialization && _Blockly.serialization.blocks && _Blockly.serialization.blocks.save) {
        data = _Blockly.serialization.blocks.save(block, { addCoordinates: true });
      } else {
        // fallback: try to use xml method (older Blockly)
        try {
          const xml = Blockly.Xml.blockToDom(block, /*opt_noId=*/ true);
          const text = Blockly.Xml.domToText(xml);
          // store xml string under a wrapper so paste code can handle both xml and json
          data = { _legacyXml: text };
        } catch (e) {
          console.error("[CopyPastePlugin] No serialization API available and XML fallback failed.", e);
          return;
        }
      }

      // Remove top-level 'next' from serialized so we don't capture the following chain
      stripRootNexts(data);

      const json = JSON.stringify(data);
      await navigator.clipboard.writeText(json);
      console.info("[CopyPastePlugin] Copied to clipboard.");
    } catch (err) {
      console.error("[CopyPastePlugin] Copy failed:", err);
    }
  }

  /**
   * Paste from clipboard at last mouse cursor position.
   * Handles JSON created by this plugin. Attempts to sanitize variable references before append.
   */
  async function pasteBlockFromClipboard() {
    try {
      const ws = _Blockly.getMainWorkspace();
      if (!ws) {
        console.warn("[CopyPastePlugin] No workspace found.");
        return;
      }

      const text = await navigator.clipboard.readText();
      if (!text) {
        console.warn("[CopyPastePlugin] Clipboard empty.");
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        // maybe legacy XML wrapper
        try {
          parsed = JSON.parse(text);
        } catch (ex) {
          // Not JSON — try interpret as XML legacy
          if (typeof text === "string" && text.trim().startsWith("<xml")) {
            // try XML import
            try {
              const xmlDom = Blockly.Xml.textToDom(text);
              const wsMetrics = ws.getMetrics ? ws.getMetrics() : { viewLeft: 0, viewTop: 0 };
              const pos = screenToWorkspace(ws, lastMouse.x, lastMouse.y);
              // create a temporary workspace paste location by translating XML blocks
              Blockly.Xml.domToWorkspace(xmlDom, ws);
              console.info("[CopyPastePlugin] Pasted legacy XML at cursor.");
              return;
            } catch (xmlErr) {
              console.error("[CopyPastePlugin] Failed to parse legacy XML:", xmlErr);
              return;
            }
          } else {
            console.error("[CopyPastePlugin] Clipboard content is not JSON or XML.");
            return;
          }
        }
      }

      // Sanitize: ensure variables exist and remove root next-chains
      sanitizeSerializedForWorkspace(ws, parsed);

      // compute workspace coordinates to paste at cursor
      const pos = screenToWorkspace(ws, lastMouse.x, lastMouse.y);

      // The serialized structure may be a single block or object with blocks array
      // Normalize to a block (if object contains blocks array with first item)
      // Add coordinates to the first block(s) so pasted content appears at cursor.
      // Many serialized formats accept an 'x' and 'y' on the root block.
      try {
        // Find the first block object to set coordinates on
        let targetBlock = null;
        if (Array.isArray(parsed)) {
          if (parsed.length > 0 && parsed[0].type) targetBlock = parsed[0];
        } else if (parsed.blocks && Array.isArray(parsed.blocks) && parsed.blocks.length > 0) {
          targetBlock = parsed.blocks[0];
        } else if (parsed.type) {
          targetBlock = parsed;
        }

        if (targetBlock) {
          targetBlock.x = pos.x;
          targetBlock.y = pos.y;
        }

        // Use modern append if available
        if (_Blockly && _Blockly.serialization && _Blockly.serialization.blocks && _Blockly.serialization.blocks.append) {
          try {
            _Blockly.serialization.blocks.append(parsed, ws);
            console.info("[CopyPastePlugin] Pasted at cursor.");
            return;
          } catch (appendErr) {
            // If append fails due to dropdowns/options, try a fallback sanitation pass
            console.warn("[CopyPastePlugin] Append failed, attempting fallback sanitation:", appendErr);
            // Attempt to sanitize dropdown fields that may have empty options
            // Heuristic: clear/replace any field values that are clearly invalid objects
            traverseSerializedBlocks(parsed, (b) => {
              if (b.fields && typeof b.fields === "object") {
                Object.keys(b.fields).forEach((fname) => {
                  const fval = b.fields[fname];
                  if (Array.isArray(fval) && fval.length === 0) {
                    // empty array isn't acceptable for a field value - remove it
                    delete b.fields[fname];
                  } else if (fval === null || typeof fval === "object") {
                    // unexpected type - coerce to string if possible, else remove
                    if (fval && fval.toString) b.fields[fname] = fval.toString();
                    else delete b.fields[fname];
                  }
                });
              }
            });

            // try append again after fallback sanitation
            _Blockly.serialization.blocks.append(parsed, ws);
            console.info("[CopyPastePlugin] Pasted at cursor (after fallback sanitation).");
            return;
          }
        } else {
          // no modern serialization; fallback to XML if possible
          if (parsed._legacyXml && typeof parsed._legacyXml === "string") {
            try {
              const xmlDom = Blockly.Xml.textToDom(parsed._legacyXml);
              Blockly.Xml.domToWorkspace(xmlDom, ws);
              console.info("[CopyPastePlugin] Pasted legacy XML at cursor (fallback).");
              return;
            } catch (xmlErr) {
              console.error("[CopyPastePlugin] Fallback XML paste failed:", xmlErr);
            }
          }
          console.error("[CopyPastePlugin] No serialization.append available and no fallback succeeded.");
        }
      } catch (err) {
        console.error("[CopyPastePlugin] Paste failed during append:", err);
      }
    } catch (err) {
      console.error("[CopyPastePlugin] Paste failed:", err);
    }
  }

  // ---- Context menu items with the renamed labels ----
  const copyBlockMenuItem = {
    id: "copyBlockMenuItem",
    displayText: "Copy - BF6",
    preconditionFn: () => "enabled",
    callback: (scope) => {
      if (scope && scope.block) copyBlockToClipboard(scope.block);
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

  // Initialize plugin: register menu items and attach mouse tracking
  plugin.initializeWorkspace = function () {
    try {
      const ws = _Blockly.getMainWorkspace();
      const registry = _Blockly.ContextMenuRegistry.registry;

      // remove previous items if reloading
      if (registry.getItem(copyBlockMenuItem.id)) registry.unregister(copyBlockMenuItem.id);
      if (registry.getItem(pasteBlockMenuItem.id)) registry.unregister(pasteBlockMenuItem.id);

      registry.register(copyBlockMenuItem);
      registry.register(pasteBlockMenuItem);

      attachMouseTracking(ws);

      console.info("[CopyPastePlugin] Initialized and ready.");
    } catch (err) {
      console.error("[CopyPastePlugin] Initialization error:", err);
    }
  };
})();
