# Página web de AgroConnecta — Nginx sin privilegios (puerto 8080)
FROM nginxinc/nginx-unprivileged:1.27-alpine

# A dónde reenviar /api y /uploads (en Docker Compose: api:3000; en Kubernetes: agroconnecta-api:3000)
ENV API_UPSTREAM=api:3000

COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --chown=nginx:nginx *.html *.js /usr/share/nginx/html/
COPY --chown=nginx:nginx css/app.css /usr/share/nginx/html/css/app.css
COPY --chown=nginx:nginx js /usr/share/nginx/html/js
COPY --chown=nginx:nginx img /usr/share/nginx/html/img
COPY --chown=nginx:nginx vendor /usr/share/nginx/html/vendor

EXPOSE 8080
