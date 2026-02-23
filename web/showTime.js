// Cloudflare Worker 代码 - 北京时间显示
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>北京时间</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #ffffff;
      font-family: 'Arial', 'Microsoft YaHei', sans-serif;
    }
    
    .time-container {
      text-align: center;
    }
    
    .time-display {
      font-size: 6rem;
      color: #000000;
      font-weight: bold;
      letter-spacing: 0.1em;
      font-family: 'Courier New', monospace;
    }
    
    .colon {
      display: inline-block;
      animation: blink 1s infinite;
    }
    
    @keyframes blink {
      0%, 49% { opacity: 1; }
      50%, 100% { opacity: 0; }
    }
    
    .date-display {
      font-size: 2rem;
      color: #333333;
      margin-top: 2rem;
    }
    
    .label {
      font-size: 1.5rem;
      color: #666666;
      margin-bottom: 1rem;
    }
    
    @media (max-width: 768px) {
      .time-display {
        font-size: 3rem;
      }
      .date-display {
        font-size: 1.2rem;
        margin-top: 1rem;
      }
      .label {
        font-size: 1rem;
      }
    }
  </style>
</head>
<body>
  <div class="time-container">
    <div class="label">北京时间</div>
    <div class="time-display" id="timeDisplay"></div>
    <div class="date-display" id="dateDisplay"></div>
  </div>

  <script>
    function updateTime() {
      const now = new Date();
      
      // 获取北京时间 (UTC+8)
      const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
      const beijingTime = new Date(utc + (3600000 * 8));
      
      // 格式化时间
      const hours = String(beijingTime.getHours()).padStart(2, '0');
      const minutes = String(beijingTime.getMinutes()).padStart(2, '0');
      const seconds = String(beijingTime.getSeconds()).padStart(2, '0');
      
      // 格式化日期
      const year = beijingTime.getFullYear();
      const month = String(beijingTime.getMonth() + 1).padStart(2, '0');
      const day = String(beijingTime.getDate()).padStart(2, '0');
      const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
      const weekday = weekdays[beijingTime.getDay()];
      
      // 更新显示（冒号会通过 CSS 动画闪烁）
      document.getElementById('timeDisplay').innerHTML = 
        hours + '<span class="colon">:</span>' + 
        minutes + '<span class="colon">:</span>' + 
        seconds;
      
      document.getElementById('dateDisplay').textContent = 
        year + '年' + month + '月' + day + '日 ' + weekday;
    }
    
    // 每秒更新一次
    updateTime();
    setInterval(updateTime, 1000);
  </script>
</body>
</html>
  `;

  return new Response(html, {
    headers: {
      'content-type': 'text/html;charset=UTF-8',
    },
  })
}
