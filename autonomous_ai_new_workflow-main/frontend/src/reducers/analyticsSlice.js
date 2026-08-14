import { createSlice } from "@reduxjs/toolkit";

const initialState = {
  conversations: {},
  tabOrder: [],
  activeTabId: null,
  loading: false,
};

const analyticsSlice = createSlice({
  name: "analytics",
  initialState,
  reducers: {
    setLoading(state, action) {
      state.loading = action.payload;
    },

    addNewTab(state, action) {
      const { tabId, message } = action.payload;
      state.conversations[tabId] = [message];
      state.tabOrder.push({
        tabId,
        prompt: message.prompt,
      });
      state.activeTabId = tabId;
    },

    addFollowup(state, action) {
      const { tabId, message } = action.payload;
      if (!state.conversations[tabId]) return;
      state.conversations[tabId].push(message);
    },

    removeTab(state, action) {
      const tabId = action.payload;
      delete state.conversations[tabId];
      state.tabOrder = state.tabOrder.filter((tab) => tab.tabId !== tabId);
      // update active tab if needed
      if (state.activeTabId === tabId) {
        state.activeTabId =
          state.tabOrder.length > 0 ? state.tabOrder[0].tabId : null;
      }
    },

    setActiveTab(state, action) {
      state.activeTabId = action.payload;
    },

    clearConversations(state) {
      state.conversations = {};
      state.tabOrder = [];
      state.activeTabId = null;
      state.loading = false;
    },
  },
});

export const {
  setLoading,
  addNewTab,
  addFollowup,
  setActiveTab,
  removeTab,
  clearConversations,
} = analyticsSlice.actions;

export default analyticsSlice.reducer;
