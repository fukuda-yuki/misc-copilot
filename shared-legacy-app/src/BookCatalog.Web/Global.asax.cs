using System;
using System.Data.Entity;
using System.IO;
using System.Linq;
using System.Web;
using System.Web.Mvc;
using System.Web.Routing;
using BookCatalog.Web.Models;

namespace BookCatalog.Web
{
    public class MvcApplication : HttpApplication
    {
        protected void Application_Start()
        {
            Directory.CreateDirectory((string)AppDomain.CurrentDomain.GetData("DataDirectory"));
            Database.SetInitializer(new BookCatalogInitializer());

            // Force DB creation and seed if empty
            using (var db = new ApplicationDbContext())
            {
                db.Database.Initialize(force: false);
                if (!db.Books.Any())
                {
                    BookCatalogInitializer.SeedBooks(db);
                }
            }

            AreaRegistration.RegisterAllAreas();
            FilterConfig.RegisterGlobalFilters(GlobalFilters.Filters);
            RouteConfig.RegisterRoutes(RouteTable.Routes);
        }
    }
}
