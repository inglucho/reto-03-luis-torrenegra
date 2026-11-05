import { describe, expect, test } from "bun:test";
import { markdown } from "../web/markdown";

describe("markdown del chat", () => {
  test("tablas, títulos, negritas y listas", () => {
    const html = markdown("### Resumen\n\n| Caso | OC |\n|---|---|\n| sol-001 | **4500000001** |\n\n- uno\n- dos");
    expect(html).toContain("<h5>Resumen</h5>");
    expect(html).toContain("<th>Caso</th>");
    expect(html).toContain("<td><strong>4500000001</strong></td>");
    expect(html).toContain("<ul><li>uno</li><li>dos</li></ul>");
  });

  test("escapa el HTML: el texto del modelo no puede inyectar código", () => {
    const html = markdown('<img src=x onerror="alert(1)"> y <script>alert(2)</script>');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });

  test("solo enlaces http(s)", () => {
    expect(markdown("[ok](https://periferia.com)")).toContain('href="https://periferia.com"');
    expect(markdown("[mal](javascript:alert(1))")).not.toContain("href");
  });
});
