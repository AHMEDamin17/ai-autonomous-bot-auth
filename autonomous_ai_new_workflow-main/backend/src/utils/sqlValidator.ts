
export function validateSqlExpression(expr: string): { valid: boolean; error?: string } {
  if (!expr || expr.trim() === "") return { valid: false, error: "Expression is empty" };
  const upper = expr.toUpperCase();
  
  const dangerousPatterns = [
    ";", "DROP ", "DELETE ", "UPDATE ", "INSERT ", "ALTER ", "TRUNCATE ",
    "GRANT ", "REVOKE ", "EXEC ", "EXECUTE ",
    "UNION ", "SELECT ", "SLEEP(", "BENCHMARK(",
    "--", "/*", "*/"
  ];

  for (const pattern of dangerousPatterns) {
    if (upper.includes(pattern)) {
      return { valid: false, error: `Invalid SQL characters/keywords detected` };
    }
  }

  let parens = 0;
  for (const char of expr) {
    if (char === '(') parens++;
    if (char === ')') parens--;
    if (parens < 0) return { valid: false, error: "Unbalanced parentheses" };
  }
  if (parens !== 0) return { valid: false, error: "Unbalanced parentheses" };

  return { valid: true };
}
