import dbService from './db.js';

class ReportsController {
  constructor() {
    this.sales = [];
    this.expenses = [];
  }

  async loadData() {
    this.sales = await dbService.getCollection('orders');
    this.expenses = await dbService.getCollection('expenses');
  }

  // --- STATS AGGREGATORS ---
  getDashboardStats() {
    const todayStr = new Date().toISOString().slice(0, 10);
    const todaySales = this.sales.filter(s => s.date === todayStr);
    
    const totals = {
      todayRevenue: todaySales.reduce((sum, s) => sum + s.grandTotal, 0),
      todayOrders: todaySales.length,
      monthlyRevenue: 0,
      yearlyRevenue: 0,
      totalExpenses: this.expenses.reduce((sum, e) => sum + e.amount, 0),
      netProfit: 0
    };

    // Monthly / Yearly revenue calculators
    const currentMonth = new Date().toISOString().slice(5, 7);
    const currentYear = new Date().getFullYear().toString();

    this.sales.forEach(sale => {
      if (sale.date && sale.date.includes(currentYear)) {
        totals.yearlyRevenue += sale.grandTotal;
        if (sale.date.slice(5, 7) === currentMonth) {
          totals.monthlyRevenue += sale.grandTotal;
        }
      }
    });

    totals.netProfit = (totals.yearlyRevenue - totals.totalExpenses);

    return totals;
  }

  // Get Top Selling Items
  getTopSellingItems(limit = 5) {
    const counts = {};
    this.sales.forEach(sale => {
      sale.items.forEach(item => {
        counts[item.name] = (counts[item.name] || 0) + item.qty;
      });
    });

    return Object.entries(counts)
      .map(([name, qty]) => ({ name, qty }))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, limit);
  }

  // --- EXPORT SUITE ---

  // Export to CSV
  exportToCSV(headers, rows, filename) {
    const csvContent = "data:text/csv;charset=utf-8," 
      + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", filename + ".csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // Export to Excel format
  exportToExcel(headers, rows, filename) {
    // Excel XML spreadsheet layout
    let xml = `<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Sheet1"><Table>`;
    
    // Headers row
    xml += '<Row>';
    headers.forEach(h => {
      xml += `<Cell><Data ss:Type="String">${h}</Data></Cell>`;
    });
    xml += '</Row>';

    // Data rows
    rows.forEach(r => {
      xml += '<Row>';
      r.forEach(val => {
        const type = isNaN(val) ? 'String' : 'Number';
        xml += `<Cell><Data ss:Type="${type}">${val}</Data></Cell>`;
      });
      xml += '</Row>';
    });

    xml += '</Table></Worksheet></Workbook>';

    const blob = new Blob([xml], { type: 'application/vnd.ms-excel' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename + '.xls';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // Generate printable PDF report
  printPDFReport(title, headers, rows) {
    const printWindow = window.open('', '_blank');
    const tableHeader = headers.map(h => `<th style="padding: 10px; border-bottom: 2px solid #ddd; text-align: left;">${h}</th>`).join('');
    const tableRows = rows.map(r => `
      <tr>
        ${r.map(val => `<td style="padding: 8px 10px; border-bottom: 1px solid #eee;">${val}</td>`).join('')}
      </tr>
    `).join('');

    printWindow.document.write(`
      <html>
        <head>
          <title>${title}</title>
          <style>
            body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; padding: 20px; color: #333; }
            h1 { font-size: 24px; text-align: center; margin-bottom: 5px; }
            p { text-align: center; font-size: 14px; color: #666; margin-top: 0; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; }
            .footer { margin-top: 30px; text-align: right; font-size: 12px; color: #777; }
          </style>
        </head>
        <body>
          <h1>${title}</h1>
          <p>Generated on: ${new Date().toLocaleString()}</p>
          <table>
            <thead>
              <tr>${tableHeader}</tr>
            </thead>
            <tbody>
              ${tableRows}
            </tbody>
          </table>
          <div class="footer">RestoPOS Reporting Engine</div>
          <script>
            window.onload = function() { window.print(); window.close(); }
          </script>
        </body>
      </html>
    `);
    printWindow.document.close();
  }
}

const reportsInstance = new ReportsController();
window.reportsController = reportsInstance;
export default reportsInstance;
