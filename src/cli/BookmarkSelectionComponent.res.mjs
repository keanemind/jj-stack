// Generated by ReScript, PLEASE EDIT WITH CARE

import * as $$Ink from "ink";
import * as React from "react";
import * as Caml_int32 from "rescript/lib/es6/caml_int32.js";
import * as Core__Array from "@rescript/core/src/Core__Array.res.mjs";
import * as Core__Option from "@rescript/core/src/Core__Option.res.mjs";
import * as JsxRuntime from "react/jsx-runtime";

function applyDefaultSelections(segments) {
  var selections = new Map();
  segments.forEach(function (segment, _segmentIndex) {
        if (segment.bookmarks.length <= 1) {
          return ;
        }
        var bookmarksWithRemotes = segment.bookmarks.filter(function (b) {
              return b.hasRemote;
            });
        if (bookmarksWithRemotes.length !== 1) {
          return ;
        }
        var defaultBookmark = Core__Option.getExn(bookmarksWithRemotes[0], undefined);
        var bookmarkIndex = Core__Array.findIndexOpt(segment.bookmarks, (function (b) {
                return b.name === defaultBookmark.name;
              }));
        if (bookmarkIndex === undefined) {
          return ;
        }
        var changeId = Core__Option.getExn(segment.bookmarks[0], undefined).changeId;
        selections.set(changeId, bookmarkIndex);
      });
  return selections;
}

function getSelectableSegmentIndices(segments) {
  var indices = [];
  segments.forEach(function (segment, index) {
        if (segment.bookmarks.length > 1) {
          indices.push(index);
          return ;
        }
        
      });
  return indices;
}

function areAllSelectionsComplete(segments, selections) {
  return segments.every(function (segment) {
              if (segment.bookmarks.length === 1) {
                return true;
              }
              var changeId = Core__Option.getExn(segment.bookmarks[0], undefined).changeId;
              return selections.has(changeId);
            });
}

function getSelectedBookmarks(segments, selections) {
  var selectedBookmarks = [];
  segments.forEach(function (segment) {
        if (segment.bookmarks.length === 1) {
          selectedBookmarks.push(Core__Option.getExn(segment.bookmarks[0], undefined));
          return ;
        }
        var changeId = Core__Option.getExn(segment.bookmarks[0], undefined).changeId;
        var selectedIndex = Core__Option.getOr(selections.get(changeId), 0);
        selectedBookmarks.push(Core__Option.getExn(segment.bookmarks[selectedIndex], undefined));
      });
  return selectedBookmarks;
}

function BookmarkSelectionComponent(props) {
  var onComplete = props.onComplete;
  var segments = props.segments;
  var selectableSegmentIndices = React.useMemo((function () {
          return getSelectableSegmentIndices(segments);
        }), [segments]);
  var match = React.useState(function () {
        var defaultSelections = applyDefaultSelections(segments);
        return {
                focusedSelectableIndex: 0,
                selections: defaultSelections
              };
      });
  var setSelectionState = match[1];
  var selectionState = match[0];
  var isComplete = areAllSelectionsComplete(segments, selectionState.selections);
  $$Ink.useInput((function (param, key) {
          if (key.return && isComplete) {
            var selectedBookmarks = getSelectedBookmarks(segments, selectionState.selections);
            onComplete(selectedBookmarks);
          } else if (key.upArrow) {
            setSelectionState(function (state) {
                  if (state.focusedSelectableIndex > 0) {
                    return {
                            focusedSelectableIndex: state.focusedSelectableIndex - 1 | 0,
                            selections: state.selections
                          };
                  } else {
                    return state;
                  }
                });
          } else if (key.downArrow) {
            setSelectionState(function (state) {
                  if (state.focusedSelectableIndex < (selectableSegmentIndices.length - 1 | 0)) {
                    return {
                            focusedSelectableIndex: state.focusedSelectableIndex + 1 | 0,
                            selections: state.selections
                          };
                  } else {
                    return state;
                  }
                });
          } else if (key.leftArrow || key.rightArrow) {
            setSelectionState(function (state) {
                  if (selectableSegmentIndices.length === 0) {
                    return state;
                  }
                  var focusedSegmentIndex = Core__Option.getExn(selectableSegmentIndices[state.focusedSelectableIndex], undefined);
                  var focusedSegment = Core__Option.getExn(segments[focusedSegmentIndex], undefined);
                  var changeId = Core__Option.getExn(focusedSegment.bookmarks[0], undefined).changeId;
                  var currentSelection = Core__Option.getOr(state.selections.get(changeId), 0);
                  var bookmarkCount = focusedSegment.bookmarks.length;
                  var newSelection = key.rightArrow ? Caml_int32.mod_(currentSelection + 1 | 0, bookmarkCount) : Caml_int32.mod_((currentSelection - 1 | 0) + bookmarkCount | 0, bookmarkCount);
                  var newSelections = new Map(Array.from(state.selections.entries()));
                  newSelections.set(changeId, newSelection);
                  return {
                          focusedSelectableIndex: state.focusedSelectableIndex,
                          selections: newSelections
                        };
                });
          }
          
        }), undefined);
  var tmp;
  if (isComplete) {
    var selectableCount = selectableSegmentIndices.length;
    tmp = JsxRuntime.jsx(React.Fragment, {
          children: JsxRuntime.jsx($$Ink.Text, {
                children: "Press Enter to continue (" + selectableCount.toString() + "/" + selectableCount.toString() + " selections made)\n"
              })
        });
  } else {
    var completedCount = selectableSegmentIndices.filter(function (segmentIndex) {
          var segment = Core__Option.getExn(segments[segmentIndex], undefined);
          var changeId = Core__Option.getExn(segment.bookmarks[0], undefined).changeId;
          return selectionState.selections.has(changeId);
        }).length;
    var totalCount = selectableSegmentIndices.length;
    tmp = JsxRuntime.jsx($$Ink.Text, {
          children: "Make selections to continue (" + completedCount.toString() + "/" + totalCount.toString() + " selections made)\n"
        });
  }
  return JsxRuntime.jsxs(React.Fragment, {
              children: [
                JsxRuntime.jsx($$Ink.Text, {
                      children: "Select bookmarks for submission:\n"
                    }),
                segments.map(function (segment, segmentIndex) {
                      var changeId = Core__Option.getExn(segment.bookmarks[0], undefined).changeId;
                      var isSelectable = segment.bookmarks.length > 1;
                      var isFocused;
                      if (isSelectable) {
                        var selectableIndex = Core__Array.findIndexOpt(selectableSegmentIndices, (function (i) {
                                return i === segmentIndex;
                              }));
                        isFocused = selectableIndex !== undefined ? selectableIndex === selectionState.focusedSelectableIndex : false;
                      } else {
                        isFocused = false;
                      }
                      var focusIndicator = isFocused ? JsxRuntime.jsx($$Ink.Text, {
                              children: "▶ ",
                              color: "red"
                            }) : JsxRuntime.jsx($$Ink.Text, {
                              children: "  "
                            });
                      var bookmarkDisplay;
                      if (segment.bookmarks.length === 1) {
                        var bookmark = Core__Option.getExn(segment.bookmarks[0], undefined);
                        bookmarkDisplay = JsxRuntime.jsxs(React.Fragment, {
                              children: [
                                JsxRuntime.jsx($$Ink.Text, {
                                      children: bookmark.name
                                    }),
                                JsxRuntime.jsx($$Ink.Text, {
                                      children: " ✓"
                                    })
                              ]
                            });
                      } else {
                        var maybeSelectedIndex = selectionState.selections.get(changeId);
                        bookmarkDisplay = JsxRuntime.jsx(React.Fragment, {
                              children: segment.bookmarks.map(function (bookmark, bookmarkIndex) {
                                    var isSelected = maybeSelectedIndex !== undefined ? bookmarkIndex === maybeSelectedIndex : false;
                                    var bookmarkElement = isSelected && isFocused ? JsxRuntime.jsx($$Ink.Text, {
                                            children: bookmark.name,
                                            color: "red",
                                            underline: true,
                                            bold: true
                                          }) : (
                                        isSelected ? JsxRuntime.jsx($$Ink.Text, {
                                                children: bookmark.name,
                                                underline: true,
                                                bold: true
                                              }) : JsxRuntime.jsx($$Ink.Text, {
                                                children: bookmark.name
                                              })
                                      );
                                    if (bookmarkIndex < (segment.bookmarks.length - 1 | 0)) {
                                      return JsxRuntime.jsxs(React.Fragment, {
                                                  children: [
                                                    bookmarkElement,
                                                    JsxRuntime.jsx($$Ink.Text, {
                                                          children: " "
                                                        })
                                                  ]
                                                }, bookmarkIndex.toString());
                                    } else {
                                      return JsxRuntime.jsx(React.Fragment, {
                                                  children: bookmarkElement
                                                }, bookmarkIndex.toString());
                                    }
                                  })
                            });
                      }
                      return JsxRuntime.jsxs($$Ink.Text, {
                                  children: [
                                    focusIndicator,
                                    "Change " + changeId + ": ",
                                    bookmarkDisplay
                                  ]
                                }, segmentIndex.toString());
                    }),
                JsxRuntime.jsx($$Ink.Text, {
                      children: "\n"
                    }),
                JsxRuntime.jsx($$Ink.Text, {
                      children: "Use ↑↓ to navigate changes, ←→ to select bookmark\n"
                    }),
                tmp
              ]
            });
}

var $$Text;

var make = BookmarkSelectionComponent;

export {
  $$Text ,
  applyDefaultSelections ,
  getSelectableSegmentIndices ,
  areAllSelectionsComplete ,
  getSelectedBookmarks ,
  make ,
}
/* ink Not a pure module */
