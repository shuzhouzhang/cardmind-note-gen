import { create } from 'zustand'

interface NoteGenServerPairingState {
  pendingUri: string | null
  receive: (uri: string) => void
  consume: () => string | null
}

export const useNoteGenServerPairingStore = create<NoteGenServerPairingState>((set, get) => ({
  pendingUri: null,
  receive: (pendingUri) => set({ pendingUri }),
  consume: () => {
    const pendingUri = get().pendingUri
    set({ pendingUri: null })
    return pendingUri
  },
}))
