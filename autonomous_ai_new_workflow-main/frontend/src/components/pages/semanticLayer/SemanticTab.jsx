import { Suspense, useState } from "react";
import { Outlet } from "react-router-dom";
import TabsHeader from "./TabsHeader";
import Loading from "../../../utils/Loading";

export default function SemanticTab() {
  // 1. Connection State
  const [globalConnectionId, setGlobalConnectionId] = useState(() => {
    return localStorage.getItem("active_connection_id") || "";
  });

  const updateGlobalConnectionId = (id) => {
    setGlobalConnectionId(id);
    if (id) {
      localStorage.setItem("active_connection_id", id);
    } else {
      localStorage.removeItem("active_connection_id");
    }
  };

  return (
    <>
      <div
        className="bg-(--theme-card-bg) mx-4 md:mx-[68px] lg:mx-[68px] my-4 rounded-2xl flex flex-col overflow-hidden"
        style={{ height: 'calc(100% - 2rem)' }}
      >
        <div className="flex-none py-2 sm:py-3 md:py-4 px-4 sm:px-6 bg-white border-b border-gray-200 rounded-t-2xl z-10">
          <div className="max-w-7xl mx-auto">
            <TabsHeader />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto pt-4 sm:pt-6 md:pt-8 pb-4 sm:pb-6 px-4 sm:px-6">
          <div className="max-w-7xl mx-auto pb-8">
            <Suspense fallback={<Loading />}>
              <Outlet context={{
                globalConnectionId,
                setGlobalConnectionId: updateGlobalConnectionId,
              }} />
            </Suspense>
          </div>
        </div>
      </div>
    </>
  );
}
