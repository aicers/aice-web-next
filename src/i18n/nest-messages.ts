type FlatMessages = Record<string, string>;

export function nestMessages(messages: FlatMessages) {
  return Object.entries(messages).reduce<Record<string, unknown>>(
    (accumulator, [compoundKey, value]) => {
      const segments = compoundKey.split(".");
      let current: Record<string, unknown> = accumulator;

      segments.forEach((segment, index) => {
        if (index === segments.length - 1) {
          current[segment] = value;
          return;
        }

        if (typeof current[segment] !== "object" || current[segment] === null) {
          current[segment] = {};
        }

        current = current[segment] as Record<string, unknown>;
      });

      return accumulator;
    },
    {},
  );
}
