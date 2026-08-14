export const ASYNC_STATUS = Object.freeze({
  IDLE: "idle",
  LOADING: "loading",
  SUCCESS: "success",
  ERROR: "error",
});

export const isLoading = (status) => status === ASYNC_STATUS.LOADING;
export const isError = (status) => status === ASYNC_STATUS.ERROR;
