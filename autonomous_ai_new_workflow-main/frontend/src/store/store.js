import { configureStore } from "@reduxjs/toolkit";
import analyticsSlice from "../reducers/analyticsSlice";

export const store = configureStore({
  reducer: {
    analytics: analyticsSlice,
  },
});
