# deploy.sh
VER=$(date +%Y%m%d%H%M%S)
sed -i "s/?v=[0-9]*/?v=$VER/g" index.html