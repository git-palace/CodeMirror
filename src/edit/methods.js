import { deleteNearSelection } from "./deleteNearSelection"
import { changeLine } from "../model/changes"
import { commands } from "./commands"
import { attachDoc } from "../model/document_data"
import { activeElt, addClass, rmClass } from "../util/dom"
import { eventMixin, signal } from "../util/event"
import { getLineStyles, getStateBefore, takeToken } from "../line/highlight"
import { indentLine } from "../input/indent"
import { triggerElectric } from "../input/input"
import { onKeyDown, onKeyPress, onKeyUp } from "./key_events"
import { getKeyMap } from "../input/keymap"
import { methodOp, operation, runInOp } from "../display/operations"
import { clipLine, clipPos, cmp, Pos } from "../line/pos"
import { charCoords, charWidth, clearCaches, clearLineMeasurementCache, coordsChar, cursorCoords, displayHeight, displayWidth, estimateLineHeights, fromCoordSystem, intoCoordSystem, scrollGap, textHeight } from "../measurement/position_measurement"
import { Range } from "../model/selection"
import { replaceOneSelection, skipAtomic } from "../model/selection_updates"
import { addToScrollPos, calculateScrollPos, ensureCursorVisible, resolveScrollToPos, scrollIntoView } from "../display/scrolling"
import { heightAtLine } from "../line/spans"
import { updateGutterSpace } from "../display/update_display"
import { lineLeft, lineRight, moveLogically, moveVisually } from "../util/bidi"
import { indexOf, insertSorted, isEmpty, isWordChar, sel_dontScroll, sel_move } from "../util/misc"
import { signalLater } from "../util/operation_group"
import { getLine, isLine, lineAtHeight, lineNo } from "../line/utils_line"
import { regChange, regLineChange } from "../display/view_tracking"

// The publicly visible API. Note that methodOp(f) means
// 'wrap f in an operation, performed on its `this` parameter'.

// This is not the complete set of editor methods. Most of the
// methods defined on the Doc type are also injected into
// CodeMirror.prototype, for backwards compatibility and
// convenience.

export default function(CodeMirror) {
  let optionHandlers = CodeMirror.optionHandlers

  let helpers = CodeMirror.helpers = {}

  CodeMirror.prototype = {
    constructor: CodeMirror,
    focus: function(){window.focus(); this.display.input.focus()},

    setOption: function(option, value) {
      let options = this.options, old = options[option]
      if (options[option] == value && option != "mode") return
      options[option] = value
      if (optionHandlers.hasOwnProperty(option))
        operation(this, optionHandlers[option])(this, value, old)
    },

    getOption: function(option) {return this.options[option]},
    getDoc: function() {return this.doc},

    addKeyMap: function(map, bottom) {
      this.state.keyMaps[bottom ? "push" : "unshift"](getKeyMap(map))
    },
    removeKeyMap: function(map) {
      let maps = this.state.keyMaps
      for (let i = 0; i < maps.length; ++i)
        if (maps[i] == map || maps[i].name == map) {
          maps.splice(i, 1)
          return true
        }
    },

    addOverlay: methodOp(function(spec, options) {
      let mode = spec.token ? spec : CodeMirror.getMode(this.options, spec)
      if (mode.startState) throw new Error("Overlays may not be stateful.")
      insertSorted(this.state.overlays,
                   {mode: mode, modeSpec: spec, opaque: options && options.opaque,
                    priority: (options && options.priority) || 0},
                   overlay => overlay.priority)
      this.state.modeGen++
      regChange(this)
    }),
    removeOverlay: methodOp(function(spec) {
      let overlays = this.state.overlays
      for (let i = 0; i < overlays.length; ++i) {
        let cur = overlays[i].modeSpec
        if (cur == spec || typeof spec == "string" && cur.name == spec) {
          overlays.splice(i, 1)
          this.state.modeGen++
          regChange(this)
          return
        }
      }
    }),

    indentLine: methodOp(function(n, dir, aggressive) {
      if (typeof dir != "string" && typeof dir != "number") {
        if (dir == null) dir = this.options.smartIndent ? "smart" : "prev"
        else dir = dir ? "add" : "subtract"
      }
      if (isLine(this.doc, n)) indentLine(this, n, dir, aggressive)
    }),
    indentSelection: methodOp(function(how) {
      let ranges = this.doc.sel.ranges, end = -1
      for (let i = 0; i < ranges.length; i++) {
        let range = ranges[i]
        if (!range.empty()) {
          let from = range.from(), to = range.to()
          let start = Math.max(end, from.line)
          end = Math.min(this.lastLine(), to.line - (to.ch ? 0 : 1)) + 1
          for (let j = start; j < end; ++j)
            indentLine(this, j, how)
          let newRanges = this.doc.sel.ranges
          if (from.ch == 0 && ranges.length == newRanges.length && newRanges[i].from().ch > 0)
            replaceOneSelection(this.doc, i, new Range(from, newRanges[i].to()), sel_dontScroll)
        } else if (range.head.line > end) {
          indentLine(this, range.head.line, how, true)
          end = range.head.line
          if (i == this.doc.sel.primIndex) ensureCursorVisible(this)
        }
      }
    }),

    // Fetch the parser token for a given character. Useful for hacks
    // that want to inspect the mode state (say, for completion).
    getTokenAt: function(pos, precise) {
      return takeToken(this, pos, precise)
    },

    getLineTokens: function(line, precise) {
      return takeToken(this, Pos(line), precise, true)
    },

    getTokenTypeAt: function(pos) {
      pos = clipPos(this.doc, pos)
      let styles = getLineStyles(this, getLine(this.doc, pos.line))
      let before = 0, after = (styles.length - 1) / 2, ch = pos.ch
      let type
      if (ch == 0) type = styles[2]
      else for (;;) {
        let mid = (before + after) >> 1
        if ((mid ? styles[mid * 2 - 1] : 0) >= ch) after = mid
        else if (styles[mid * 2 + 1] < ch) before = mid + 1
        else { type = styles[mid * 2 + 2]; break }
      }
      let cut = type ? type.indexOf("overlay ") : -1
      return cut < 0 ? type : cut == 0 ? null : type.slice(0, cut - 1)
    },

    getModeAt: function(pos) {
      let mode = this.doc.mode
      if (!mode.innerMode) return mode
      return CodeMirror.innerMode(mode, this.getTokenAt(pos).state).mode
    },

    getHelper: function(pos, type) {
      return this.getHelpers(pos, type)[0]
    },

    getHelpers: function(pos, type) {
      let found = []
      if (!helpers.hasOwnProperty(type)) return found
      let help = helpers[type], mode = this.getModeAt(pos)
      if (typeof mode[type] == "string") {
        if (help[mode[type]]) found.push(help[mode[type]])
      } else if (mode[type]) {
        for (let i = 0; i < mode[type].length; i++) {
          let val = help[mode[type][i]]
          if (val) found.push(val)
        }
      } else if (mode.helperType && help[mode.helperType]) {
        found.push(help[mode.helperType])
      } else if (help[mode.name]) {
        found.push(help[mode.name])
      }
      for (let i = 0; i < help._global.length; i++) {
        let cur = help._global[i]
        if (cur.pred(mode, this) && indexOf(found, cur.val) == -1)
          found.push(cur.val)
      }
      return found
    },

    getStateAfter: function(line, precise) {
      let doc = this.doc
      line = clipLine(doc, line == null ? doc.first + doc.size - 1: line)
      return getStateBefore(this, line + 1, precise)
    },

    cursorCoords: function(start, mode) {
      let pos, range = this.doc.sel.primary()
      if (start == null) pos = range.head
      else if (typeof start == "object") pos = clipPos(this.doc, start)
      else pos = start ? range.from() : range.to()
      return cursorCoords(this, pos, mode || "page")
    },

    charCoords: function(pos, mode) {
      return charCoords(this, clipPos(this.doc, pos), mode || "page")
    },

    coordsChar: function(coords, mode) {
      coords = fromCoordSystem(this, coords, mode || "page")
      return coordsChar(this, coords.left, coords.top)
    },

    lineAtHeight: function(height, mode) {
      height = fromCoordSystem(this, {top: height, left: 0}, mode || "page").top
      return lineAtHeight(this.doc, height + this.display.viewOffset)
    },
    heightAtLine: function(line, mode, includeWidgets) {
      let end = false, lineObj
      if (typeof line == "number") {
        let last = this.doc.first + this.doc.size - 1
        if (line < this.doc.first) line = this.doc.first
        else if (line > last) { line = last; end = true }
        lineObj = getLine(this.doc, line)
      } else {
        lineObj = line
      }
      return intoCoordSystem(this, lineObj, {top: 0, left: 0}, mode || "page", includeWidgets).top +
        (end ? this.doc.height - heightAtLine(lineObj) : 0)
    },

    defaultTextHeight: function() { return textHeight(this.display) },
    defaultCharWidth: function() { return charWidth(this.display) },

    setGutterMarker: methodOp(function(line, gutterID, value) {
      return changeLine(this.doc, line, "gutter", line => {
        let markers = line.gutterMarkers || (line.gutterMarkers = {})
        markers[gutterID] = value
        if (!value && isEmpty(markers)) line.gutterMarkers = null
        return true
      })
    }),

    clearGutter: methodOp(function(gutterID) {
      let doc = this.doc, i = doc.first
      doc.iter(line => {
        if (line.gutterMarkers && line.gutterMarkers[gutterID]) {
          line.gutterMarkers[gutterID] = null
          regLineChange(this, i, "gutter")
          if (isEmpty(line.gutterMarkers)) line.gutterMarkers = null
        }
        ++i
      })
    }),

    lineInfo: function(line) {
      let n
      if (typeof line == "number") {
        if (!isLine(this.doc, line)) return null
        n = line
        line = getLine(this.doc, line)
        if (!line) return null
      } else {
        n = lineNo(line)
        if (n == null) return null
      }
      return {line: n, handle: line, text: line.text, gutterMarkers: line.gutterMarkers,
              textClass: line.textClass, bgClass: line.bgClass, wrapClass: line.wrapClass,
              widgets: line.widgets}
    },

    getViewport: function() { return {from: this.display.viewFrom, to: this.display.viewTo}},

    addWidget: function(pos, node, scroll, vert, horiz) {
      let display = this.display
      pos = cursorCoords(this, clipPos(this.doc, pos))
      let top = pos.bottom, left = pos.left
      node.style.position = "absolute"
      node.setAttribute("cm-ignore-events", "true")
      this.display.input.setUneditable(node)
      display.sizer.appendChild(node)
      if (vert == "over") {
        top = pos.top
      } else if (vert == "above" || vert == "near") {
        let vspace = Math.max(display.wrapper.clientHeight, this.doc.height),
        hspace = Math.max(display.sizer.clientWidth, display.lineSpace.clientWidth)
        // Default to positioning above (if specified and possible); otherwise default to positioning below
        if ((vert == 'above' || pos.bottom + node.offsetHeight > vspace) && pos.top > node.offsetHeight)
          top = pos.top - node.offsetHeight
        else if (pos.bottom + node.offsetHeight <= vspace)
          top = pos.bottom
        if (left + node.offsetWidth > hspace)
          left = hspace - node.offsetWidth
      }
      node.style.top = top + "px"
      node.style.left = node.style.right = ""
      if (horiz == "right") {
        left = display.sizer.clientWidth - node.offsetWidth
        node.style.right = "0px"
      } else {
        if (horiz == "left") left = 0
        else if (horiz == "middle") left = (display.sizer.clientWidth - node.offsetWidth) / 2
        node.style.left = left + "px"
      }
      if (scroll)
        scrollIntoView(this, left, top, left + node.offsetWidth, top + node.offsetHeight)
    },

    triggerOnKeyDown: methodOp(onKeyDown),
    triggerOnKeyPress: methodOp(onKeyPress),
    triggerOnKeyUp: onKeyUp,

    execCommand: function(cmd) {
      if (commands.hasOwnProperty(cmd))
        return commands[cmd].call(null, this)
    },

    triggerElectric: methodOp(function(text) { triggerElectric(this, text) }),

    findPosH: function(from, amount, unit, visually) {
      let dir = 1
      if (amount < 0) { dir = -1; amount = -amount }
      let cur = clipPos(this.doc, from)
      for (let i = 0; i < amount; ++i) {
        cur = findPosH(this.doc, cur, dir, unit, visually)
        if (cur.hitSide) break
      }
      return cur
    },

    moveH: methodOp(function(dir, unit) {
      this.extendSelectionsBy(range => {
        if (this.display.shift || this.doc.extend || range.empty())
          return findPosH(this.doc, range.head, dir, unit, this.options.rtlMoveVisually)
        else
          return dir < 0 ? range.from() : range.to()
      }, sel_move)
    }),

    deleteH: methodOp(function(dir, unit) {
      let sel = this.doc.sel, doc = this.doc
      if (sel.somethingSelected())
        doc.replaceSelection("", null, "+delete")
      else
        deleteNearSelection(this, range => {
          let other = findPosH(doc, range.head, dir, unit, false)
          return dir < 0 ? {from: other, to: range.head} : {from: range.head, to: other}
        })
    }),

    findPosV: function(from, amount, unit, goalColumn) {
      let dir = 1, x = goalColumn
      if (amount < 0) { dir = -1; amount = -amount }
      let cur = clipPos(this.doc, from)
      for (let i = 0; i < amount; ++i) {
        let coords = cursorCoords(this, cur, "div")
        if (x == null) x = coords.left
        else coords.left = x
        cur = findPosV(this, coords, dir, unit)
        if (cur.hitSide) break
      }
      return cur
    },

    moveV: methodOp(function(dir, unit) {
      let doc = this.doc, goals = []
      let collapse = !this.display.shift && !doc.extend && doc.sel.somethingSelected()
      doc.extendSelectionsBy(range => {
        if (collapse)
          return dir < 0 ? range.from() : range.to()
        let headPos = cursorCoords(this, range.head, "div")
        if (range.goalColumn != null) headPos.left = range.goalColumn
        goals.push(headPos.left)
        let pos = findPosV(this, headPos, dir, unit)
        if (unit == "page" && range == doc.sel.primary())
          addToScrollPos(this, null, charCoords(this, pos, "div").top - headPos.top)
        return pos
      }, sel_move)
      if (goals.length) for (let i = 0; i < doc.sel.ranges.length; i++)
        doc.sel.ranges[i].goalColumn = goals[i]
    }),

    // Find the word at the given position (as returned by coordsChar).
    findWordAt: function(pos) {
      let doc = this.doc, line = getLine(doc, pos.line).text
      let start = pos.ch, end = pos.ch
      if (line) {
        let helper = this.getHelper(pos, "wordChars")
        if ((pos.xRel < 0 || end == line.length) && start) --start; else ++end
        let startChar = line.charAt(start)
        let check = isWordChar(startChar, helper)
          ? ch => isWordChar(ch, helper)
          : /\s/.test(startChar) ? ch => /\s/.test(ch)
          : ch => (!/\s/.test(ch) && !isWordChar(ch))
        while (start > 0 && check(line.charAt(start - 1))) --start
        while (end < line.length && check(line.charAt(end))) ++end
      }
      return new Range(Pos(pos.line, start), Pos(pos.line, end))
    },

    toggleOverwrite: function(value) {
      if (value != null && value == this.state.overwrite) return
      if (this.state.overwrite = !this.state.overwrite)
        addClass(this.display.cursorDiv, "CodeMirror-overwrite")
      else
        rmClass(this.display.cursorDiv, "CodeMirror-overwrite")

      signal(this, "overwriteToggle", this, this.state.overwrite)
    },
    hasFocus: function() { return this.display.input.getField() == activeElt() },
    isReadOnly: function() { return !!(this.options.readOnly || this.doc.cantEdit) },

    scrollTo: methodOp(function(x, y) {
      if (x != null || y != null) resolveScrollToPos(this)
      if (x != null) this.curOp.scrollLeft = x
      if (y != null) this.curOp.scrollTop = y
    }),
    getScrollInfo: function() {
      let scroller = this.display.scroller
      return {left: scroller.scrollLeft, top: scroller.scrollTop,
              height: scroller.scrollHeight - scrollGap(this) - this.display.barHeight,
              width: scroller.scrollWidth - scrollGap(this) - this.display.barWidth,
              clientHeight: displayHeight(this), clientWidth: displayWidth(this)}
    },

    scrollIntoView: methodOp(function(range, margin) {
      if (range == null) {
        range = {from: this.doc.sel.primary().head, to: null}
        if (margin == null) margin = this.options.cursorScrollMargin
      } else if (typeof range == "number") {
        range = {from: Pos(range, 0), to: null}
      } else if (range.from == null) {
        range = {from: range, to: null}
      }
      if (!range.to) range.to = range.from
      range.margin = margin || 0

      if (range.from.line != null) {
        resolveScrollToPos(this)
        this.curOp.scrollToPos = range
      } else {
        let sPos = calculateScrollPos(this, Math.min(range.from.left, range.to.left),
                                      Math.min(range.from.top, range.to.top) - range.margin,
                                      Math.max(range.from.right, range.to.right),
                                      Math.max(range.from.bottom, range.to.bottom) + range.margin)
        this.scrollTo(sPos.scrollLeft, sPos.scrollTop)
      }
    }),

    setSize: methodOp(function(width, height) {
      let interpret = val => typeof val == "number" || /^\d+$/.test(String(val)) ? val + "px" : val
      if (width != null) this.display.wrapper.style.width = interpret(width)
      if (height != null) this.display.wrapper.style.height = interpret(height)
      if (this.options.lineWrapping) clearLineMeasurementCache(this)
      let lineNo = this.display.viewFrom
      this.doc.iter(lineNo, this.display.viewTo, line => {
        if (line.widgets) for (let i = 0; i < line.widgets.length; i++)
          if (line.widgets[i].noHScroll) { regLineChange(this, lineNo, "widget"); break }
        ++lineNo
      })
      this.curOp.forceUpdate = true
      signal(this, "refresh", this)
    }),

    operation: function(f){return runInOp(this, f)},

    refresh: methodOp(function() {
      let oldHeight = this.display.cachedTextHeight
      regChange(this)
      this.curOp.forceUpdate = true
      clearCaches(this)
      this.scrollTo(this.doc.scrollLeft, this.doc.scrollTop)
      updateGutterSpace(this)
      if (oldHeight == null || Math.abs(oldHeight - textHeight(this.display)) > .5)
        estimateLineHeights(this)
      signal(this, "refresh", this)
    }),

    swapDoc: methodOp(function(doc) {
      let old = this.doc
      old.cm = null
      attachDoc(this, doc)
      clearCaches(this)
      this.display.input.reset()
      this.scrollTo(doc.scrollLeft, doc.scrollTop)
      this.curOp.forceScroll = true
      signalLater(this, "swapDoc", this, old)
      return old
    }),

    getInputField: function(){return this.display.input.getField()},
    getWrapperElement: function(){return this.display.wrapper},
    getScrollerElement: function(){return this.display.scroller},
    getGutterElement: function(){return this.display.gutters}
  }
  eventMixin(CodeMirror)

  CodeMirror.registerHelper = function(type, name, value) {
    if (!helpers.hasOwnProperty(type)) helpers[type] = CodeMirror[type] = {_global: []}
    helpers[type][name] = value
  }
  CodeMirror.registerGlobalHelper = function(type, name, predicate, value) {
    CodeMirror.registerHelper(type, name, value)
    helpers[type]._global.push({pred: predicate, val: value})
  }
}

// Used for horizontal relative motion. Dir is -1 or 1 (left or
// right), unit can be "char", "column" (like char, but doesn't
// cross line boundaries), "word" (across next word), or "group" (to
// the start of next group of word or non-word-non-whitespace
// chars). The visually param controls whether, in right-to-left
// text, direction 1 means to move towards the next index in the
// string, or towards the character to the right of the current
// position. The resulting position will have a hitSide=true
// property if it reached the end of the document.
function findPosH(doc, pos, dir, unit, visually) {
  let line = pos.line, ch = pos.ch, origDir = dir
  let lineObj = getLine(doc, line)
  function findNextLine() {
    let l = line + dir
    if (l < doc.first || l >= doc.first + doc.size) return false
    line = l
    return lineObj = getLine(doc, l)
  }
  function moveOnce(boundToLine) {
    let next = (visually ? moveVisually : moveLogically)(lineObj, ch, dir, true)
    if (next == null) {
      if (!boundToLine && findNextLine()) {
        if (visually) ch = (dir < 0 ? lineRight : lineLeft)(lineObj)
        else ch = dir < 0 ? lineObj.text.length : 0
      } else return false
    } else ch = next
    return true
  }

  if (unit == "char") {
    moveOnce()
  } else if (unit == "column") {
    moveOnce(true)
  } else if (unit == "word" || unit == "group") {
    let sawType = null, group = unit == "group"
    let helper = doc.cm && doc.cm.getHelper(pos, "wordChars")
    for (let first = true;; first = false) {
      if (dir < 0 && !moveOnce(!first)) break
      let cur = lineObj.text.charAt(ch) || "\n"
      let type = isWordChar(cur, helper) ? "w"
        : group && cur == "\n" ? "n"
        : !group || /\s/.test(cur) ? null
        : "p"
      if (group && !first && !type) type = "s"
      if (sawType && sawType != type) {
        if (dir < 0) {dir = 1; moveOnce()}
        break
      }

      if (type) sawType = type
      if (dir > 0 && !moveOnce(!first)) break
    }
  }
  let result = skipAtomic(doc, Pos(line, ch), pos, origDir, true)
  if (!cmp(pos, result)) result.hitSide = true
  return result
}

// For relative vertical movement. Dir may be -1 or 1. Unit can be
// "page" or "line". The resulting position will have a hitSide=true
// property if it reached the end of the document.
function findPosV(cm, pos, dir, unit) {
  let doc = cm.doc, x = pos.left, y
  if (unit == "page") {
    let pageSize = Math.min(cm.display.wrapper.clientHeight, window.innerHeight || document.documentElement.clientHeight)
    let moveAmount = Math.max(pageSize - .5 * textHeight(cm.display), 3)
    y = (dir > 0 ? pos.bottom : pos.top) + dir * moveAmount

  } else if (unit == "line") {
    y = dir > 0 ? pos.bottom + 3 : pos.top - 3
  }
  let target
  for (;;) {
    target = coordsChar(cm, x, y)
    if (!target.outside) break
    if (dir < 0 ? y <= 0 : y >= doc.height) { target.hitSide = true; break }
    y += dir * 5
  }
  return target
}
