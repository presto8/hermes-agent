import { patchOverlayState } from './overlayStore.js'
import { PENDING, rowFor } from './sessionTabsModel.js'
import {
  $sessionTabRows,
  $sessionTabs,
  closeSessionTab,
  focusSessionTab,
  noteSessionPending,
  noteSessionShown,
  openSessionTab
} from './sessionTabsStore.js'
import { getUiState } from './uiStore.js'

export interface SessionTabActions {
  activateLiveSession: (id: string) => void
  resumeById: (id: string) => void
}

const openPicker = () => patchOverlayState({ sessions: true })

/** Switch to tab `index`: a live session is activated, a closed one resumed, an empty tab opens
 *  the picker to fill it. */
export function selectSessionTab(index: number, actions: SessionTabActions) {
  const slot = $sessionTabs.get().slots[index]

  if (!slot || slot.sessionId === PENDING) {
    return
  }

  focusSessionTab(index)

  if (slot.sessionId === null) {
    return openPicker()
  }

  const { sid, storedSid } = getUiState()

  if (slot.sessionId === sid || slot.sessionId === storedSid) {
    return
  }

  const row = rowFor($sessionTabRows.get(), slot.sessionId)

  return row ? actions.activateLiveSession(row.id) : actions.resumeById(slot.sessionId)
}

/** "+ new tab": an empty tab and the picker to fill it. */
export function newSessionTab() {
  openSessionTab()
  openPicker()
}

/** Take tab `index` off the rail; when it was the current tab, show its neighbour. */
export function closeSessionTabAt(index: number, actions: SessionTabActions) {
  const focus = closeSessionTab(index)

  if (focus !== null) {
    selectSessionTab(focus, actions)
  }
}

/**
 * The session picker's callbacks, wrapped so a pick fills the current tab. A pick with a known id
 * fills it right away; a new session holds the tab until its id arrives with the switch. Without
 * this the picker's close would read as "cancelled" and drop a tab opened for it.
 */
export function wrapPickerForTabs<
  T extends {
    onActiveSessionSelect: (id: string) => void
    onNewLiveSession: () => void
    onNewPromptSession: (prompt: string, modelArg?: string) => void
    onResumeSelect: (id: string) => void
  }
>(props: T): T {
  return {
    ...props,
    onActiveSessionSelect: (id: string) => {
      noteSessionShown(id)
      props.onActiveSessionSelect(id)
    },
    onNewLiveSession: () => {
      noteSessionPending()
      props.onNewLiveSession()
    },
    onNewPromptSession: (prompt: string, modelArg?: string) => {
      noteSessionPending()
      props.onNewPromptSession(prompt, modelArg)
    },
    onResumeSelect: (id: string) => {
      noteSessionShown(id)
      props.onResumeSelect(id)
    }
  }
}
