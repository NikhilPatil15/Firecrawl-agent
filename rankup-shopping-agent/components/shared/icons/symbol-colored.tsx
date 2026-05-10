import React from "react";
import Image from "next/image";

const SymbolColored = ({
  width = 50,
  height = 72,
  ...props
}: {
  width?: number;
  height?: number;
  [key: string]: unknown;
}) => {
  return (
    <Image
      src="/rankup_icon_3.png"
      alt="ShopSmart"
      width={width}
      height={height}
      {...props}
    />
  );
};

export default SymbolColored;
