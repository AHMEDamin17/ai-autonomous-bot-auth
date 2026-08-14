import { useEffect, useRef, useState } from "react";
import { useLocation, NavLink } from "react-router-dom";
import homeIcon from "../../assets/home-icon2.png";
import overviewIcon from "../../assets/layer-icon.svg";
import { useDispatch } from "react-redux";
import { clearConversations } from "../../reducers/analyticsSlice";
import ProfileMenu from "./ProfileMenu";
export default function Sidebar() {
  const location = useLocation();
  const dispatch = useDispatch();
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);

  const menuItems = [
    {
      path: "/",
      icon: homeIcon,
      label: "Home",
      action: () => dispatch(clearConversations()),
    },
    //{ path: "/Analytics", label: "Analytics" },
    { path: "/Layer", icon: overviewIcon, label: "Layer" },
  ];

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target))
        setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const isSameRoute = (path) => {
    if (path === "/") return location.pathname === "/";
    return location.pathname.startsWith(path);
  };

  return (
    <>
      {/* Desktop sidebar */}
      <div className="hidden md:flex fixed left-2 top-1/2 -translate-y-1/2 z-9999 h-[40vh] items-center">
        <div
          className="
            bg-white rounded-[22px] border border-(--theme-border-dark)
            shadow-[0_4px_10px_rgba(0,0,0,0.2)] py-3 px-1
            flex flex-col justify-between items-center h-full
            overflow-visible min-h-[180px]
          "
        >
          <div className="flex flex-col gap-4 py-2">
            {menuItems.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                title={item.label}
                onClick={(e) => {
                  if (isSameRoute(item.path)) {
                    e.preventDefault();
                  } else if (item.action) {
                    item.action();
                  }
                }}
                className={({ isActive }) => `
                  flex items-center justify-center rounded-xl cursor-pointer transition-colors duration-200 
                  ${isActive ? "bg-gray-100 shadow-sm" : "hover:bg-gray-100"}
                `}
              >
                <img
                  src={item.icon}
                  className="w-6 h-5 lg:w-7 lg:h-6"
                  alt={item.label}
                  title={item.label}
                />
              </NavLink>
            ))}
          </div>

          <ProfileMenu />
        </div>
      </div>

      {/* Mobile sidebar */}
      <div ref={menuRef} className="fixed top-[5px] left-3 z-9999 md:hidden">
        {/* Circular hamburger button */}
        <button
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Close navigation" : "Open navigation"}
          className="w-9 h-9 rounded-full bg-white border border-(--theme-border-dark) shadow-[0_4px_10px_rgba(0,0,0,0.2)] flex items-center justify-center transition-all duration-200 active:scale-95"
        >
          {open ? (
            <svg
              className="w-4 h-4 text-gray-600"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          ) : (
            <svg
              className="w-4 h-4 text-gray-600"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4 6h16M4 12h16M4 18h16"
              />
            </svg>
          )}
        </button>

        {/* Mobile menu pill */}
        <div
          className={`
            absolute top-12 left-0
            bg-white rounded-[22px] border border-(--theme-border-dark)
            shadow-[0_4px_10px_rgba(0,0,0,0.2)]
            w-14 py-6
            flex flex-col justify-between items-center
            transform transition-all duration-200 ease-out origin-top-left
            ${open ? "opacity-100 scale-100 pointer-events-auto" : "opacity-0 scale-95 pointer-events-none"}
          `}
          style={{ height: "40vh", minHeight: "180px" }}
        >
          {/* Nav icons — identical to desktop */}
          <div className="flex flex-col gap-4">
            {menuItems.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                title={item.label}
                onClick={(e) => {
                  if (isSameRoute(item.path)) {
                    e.preventDefault();
                  } else {
                    item.action?.();
                  }
                  setOpen(false); // Close mobile menu after navigation
                }}
                className={({ isActive }) => `
                  w-9 h-9 flex items-center justify-center rounded-xl cursor-pointer transition-colors duration-200 
                  ${isActive ? "bg-gray-100" : "hover:bg-gray-100"}
                `}
              >
                <img src={item.icon} className="w-5 h-5" alt={item.label} />
              </NavLink>
            ))}
          </div>

          {/* Avatar — identical to desktop */}
          <ProfileMenu mobile />
        </div>
      </div>
    </>
  );
}
