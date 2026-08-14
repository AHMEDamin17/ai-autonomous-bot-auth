import { useState, useEffect } from "react";
import SRMLogo from "../../assets/logo.png";

export default function Header() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const mainEl = document.querySelector("main");
    const handleScroll = () => {
      setScrolled((mainEl ? mainEl.scrollTop : window.scrollY) > 20);
    };
    if (mainEl) {
      mainEl.addEventListener("scroll", handleScroll);
    }
    window.addEventListener("scroll", handleScroll);
    return () => {
      if (mainEl) {
        mainEl.removeEventListener("scroll", handleScroll);
      }
      window.removeEventListener("scroll", handleScroll);
    };
  }, []);

  return (
    <header
      className={`
        flex-none w-full z-50
        transition-all duration-300 ease-in-out
        ${scrolled ? "shadow-md" : ""}
      `}
    >
      <div
        className="w-full py-2 transition-all duration-300 ease-in-out"
      >
        <div className="h-full flex items-center justify-between px-1 md:px-2 ">
          {/* LOGO + TITLE */}
          <div className="flex items-center gap-3 pl-14 md:pl-0">
            <img
              src={SRMLogo}
              alt="SRM Logo"
              className="
              block
              h-[30px]!
              max-h-[30px]!
              w-auto
              object-contain
              scale-[0.9]
              transition-transform duration-300
            "
            />
          </div>
          <div className="flex items-center gap-3"></div>
        </div>
      </div>
    </header>
  );
}
